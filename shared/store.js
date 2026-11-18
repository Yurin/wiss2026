const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');

const id = () => randomUUID();
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(String(value || '')).digest('hex');
const now = () => new Date().toISOString();
function check(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { statusCode: status });
}

// All mutations are synchronous transactions in one Node process. The renamed
// snapshot includes events and jobs, so neither can be lost between commits.
class Store {
  constructor(root, maxSubjects = 6) {
    this.maxSubjects = maxSubjects;
    root = path.resolve(root);
    this.root = root;
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true, mode: 0o700 });
    this.file = path.join(root, 'state.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file)) :
      { schemaVersion: 1, sessions: {}, photos: {}, references: {}, events: [], jobs: {}, settings: {} };
    this.data.settings ||= {};
    // A process may have stopped after Immich accepted a request.
    this.transaction(d => {
      for (const job of Object.values(d.jobs)) if (job.status === 'running' && job.routing === 'backend') {
        job.status = job.immichAssetId ? 'failed' : 'uncertain';
        job.error = 'サーバー再起動後の共有処理を確認してください';
        if (d.photos[job.photoId]) d.photos[job.photoId].shareStatus = job.immichAssetId ? 'retry' : 'uncertain';
      }
    });
    check(this.data.schemaVersion === 1, 'Unsupported WISS schema', 500);
  }
  transaction(fn) {
    const next = structuredClone(this.data);
    const result = fn(next);
    const temporary = `${this.file}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    this.data = next;
    return result;
  }
  event(d, eventType, fields = {}) {
    // Consent and delivery records are stored on each photo/job; no research event log.
  }
  session(d, sessionId) {
    const s = Object.hasOwn(d.sessions, sessionId) ? d.sessions[sessionId] : null;
    check(s, 'セッションが見つかりません', 404);
    return s;
  }
  actor(s, credential) {
    const h = hash(credential);
    if (s.photographerTokenHash === h) return { role: 'photographer', id: 'photographer' };
    const subject = s.subjects.find(p => p.tokenHash === h);
    check(subject, '参加資格が無効です', 401);
    return { role: 'subject', id: subject.id };
  }
  version(s, version) { check(Number.isInteger(version) && version === s.version, '状態が更新されました。再取得して操作してください', 409); }
  frame(d, frameId) {
    const ref = Object.values(d.references).find(r => r.status === 'published' && r.variants.some(v => v.id === frameId));
    check(ref, '公開中のフレームを選んでください', 404);
    return { ref, variant: ref.variants.find(v => v.id === frameId) };
  }
  createSession() {
    const credential = token();
    return this.transaction(d => {
      const host = { id: id(), tokenHash: hash(credential), joinedAt: now() };
      const s = { id: id(), joinCode: randomBytes(6).toString('hex').toUpperCase(), photographerTokenHash: null, photographerJoinCode: randomBytes(6).toString('hex').toUpperCase(), hostId: host.id,
        createdAt: now(), subjects: [host], representativeId: host.id,
        activeFrameId: null, mode: 'free', version: 0, proposals: [] };
      d.sessions[s.id] = s;
      this.event(d, 'session_created', { sessionId: s.id, subjectCount: 1 });
      return { sessionId: s.id, subjectId: host.id, token: credential };
    });
  }
  join(joinCode, role = 'subject') {
    check(role === 'subject' || role === 'photographer', '参加者の種類が無効です');
    const credential = token();
    return this.transaction(d => {
      const s = Object.values(d.sessions).find(s => ((role === 'photographer' ? s.photographerJoinCode : s.joinCode) === String(joinCode).trim().toUpperCase() || (this.maxSubjects > 1 && s.joinCode === String(joinCode).trim().toUpperCase())));
      check(s, '参加コードが見つかりません', 404);
      check(!s.closed, 'セッションは終了しています', 409);
      if (role === 'photographer') {
        check(!s.photographerTokenHash, '撮影者はすでに参加しています', 409);
        s.photographerTokenHash = hash(credential);
        s.version++;
        this.event(d, 'photographer_joined', { sessionId: s.id });
        return { sessionId: s.id, token: credential };
      }
      check(s.subjects.length < this.maxSubjects, `被写体は最大${this.maxSubjects}人です`, 409);
      const subject = { id: id(), tokenHash: hash(credential), joinedAt: now() };
      s.subjects.push(subject);
      s.representativeId ||= subject.id;
      s.version++;
      this.event(d, 'subject_joined', { sessionId: s.id, subjectId: subject.id, subjectCount: s.subjects.length });
      return { sessionId: s.id, subjectId: subject.id, token: credential };
    });
  }
  publicSession(s) {
    const reference = s.activeFrameId ? this.frame(this.data, s.activeFrameId).ref : null;
    return { id: s.id, hostId: s.hostId || null, joinCode: s.joinCode, subjects: s.subjects.map(({ tokenHash, ...p }) => p),
      representativeId: s.representativeId, activeFrameId: s.activeFrameId, mode: s.mode,
      version: s.version, proposals: s.proposals, closed: !!s.closed,
      reference: reference ? this.publicReference(reference) : null };
  }
  publicReference(r) {
    return { id: r.id, name: r.name, subjectCount: r.subjectCount, origin: r.origin, status: r.status,
      imageURL: `/api/wiss/library/${r.id}/reference`, variants: r.variants.map(v => ({ id: v.id, kind: v.kind, imageURL: `/api/wiss/library/${r.id}/${v.kind}` })) };
  }
  mutate(sessionId, credential, action, body) {
    return this.transaction(d => {
      const s = this.session(d, sessionId), actor = this.actor(s, credential);
      check(!s.closed, 'セッションは終了しています', 409);
      const subject = s.subjects.find(p => p.id === actor.id);
      const fields = { sessionId, subjectId: subject?.id, subjectCount: s.subjects.length };
      if (action === 'representative') {
        check(actor.role === 'photographer' || actor.id === s.hostId || actor.id === s.representativeId, '親機・代表者・撮影者のみ変更できます', 403);
        this.version(s, body.expectedVersion);
        check(s.subjects.some(p => p.id === body.subjectId), '参加中の被写体を選んでください');
        s.representativeId = body.subjectId;
      } else if (action === 'active-frame') {
        this.version(s, body.expectedVersion);
        check(actor.id === s.representativeId || (actor.role === 'photographer' && body.frameId === null), '代表者のみフレームを確定できます', 403);
        if (body.frameId !== null) {
          const { ref, variant } = this.frame(d, body.frameId);
          this.event(d, 'frame_activated', { ...fields, referenceId: ref.id, frameVariantId: variant.id, kind: variant.kind, origin: ref.origin });
        } else this.event(d, 'free_mode_selected', fields);
        s.activeFrameId = body.frameId;
        s.mode = body.frameId === null ? 'free' : 'frame';
      } else if (action === 'proposals' || action === 'view') {
        check(subject, '被写体の操作です', 403);
        const { ref, variant } = this.frame(d, body.frameId);
        this.event(d, action === 'view' ? 'frame_viewed' : 'frame_proposed', { ...fields, referenceId: ref.id, frameVariantId: variant.id, kind: variant.kind, origin: ref.origin });
        if (action === 'proposals') {
          s.proposals = s.proposals.filter(p => p.subjectId !== actor.id);
          s.proposals.push({ subjectId: actor.id, frameId: variant.id, referenceId: ref.id, name: ref.name, kind: variant.kind, at: now() });
        }
      } else if (action === 'close') {
        check(actor.id === s.hostId || (!s.hostId && actor.role === 'photographer'), '親機のみ終了できます', 403);
        s.closed = true;
      } else check(false, 'Unknown action');
      if (action !== 'view') s.version++;
      return s.id;
    });
  }
  job(d, key, payload) {
    d.jobs[key] ||= { id: key, ...payload, status: 'pending', attempts: 0, nextAttemptAt: 0 };
  }
  capture(sessionId, credential, body, asset) {
    return this.transaction(d => {
      const s = this.session(d, sessionId);
      check(this.actor(s, credential).role === 'photographer', '撮影者専用です', 403);
      check(!s.closed, 'セッションは終了しています', 409);
      this.version(s, body.expectedVersion);
      check(s.subjects.length > 0, '被写体の参加が必要です', 409);
      check(typeof body.captureId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(body.captureId), 'captureIdが必要です');
      const existing = Object.values(d.photos).find(p => p.sessionId === sessionId && p.captureId === body.captureId);
      if (existing) return existing;
      const selected = s.activeFrameId ? this.frame(d, s.activeFrameId) : null;
      const p = { id: id(), captureId: body.captureId, sessionId, capturedAt: now(), subjectCount: s.subjects.length,
        consentSubjectIds: s.subjects.map(subject => subject.id),
        shareConsents: {}, shareStatus: 'not-shared', shareConsentVersion: null,
        mode: s.mode, referenceId: selected?.ref.id || null, frameVariantId: s.activeFrameId,
        kind: selected?.variant.kind || null, origin: selected?.ref.origin || null,
        asset, decision: 'draft', status: 'pending' };
      d.photos[p.id] = p;
      this.event(d, 'photo_captured', { sessionId, photoId: p.id, subjectCount: p.subjectCount, referenceId: p.referenceId, frameVariantId: p.frameVariantId, kind: p.kind, origin: p.origin });
      return p;
    });
  }
  decide(sessionId, credential, photoId, decision) {
    return this.transaction(d => {
      const s = this.session(d, sessionId);
      const actor = this.actor(s, credential);
      check(actor.role === 'photographer' || decision === 'deleted', '撮影者専用です', 403);
      const p = d.photos[photoId];
      check(p && p.sessionId === sessionId, '写真が見つかりません', 404);
      check(['saved', 'deleted'].includes(decision), '保存または削除を選んでください');
      if (p.decision === decision) return p;
      check(p.decision === 'draft' || (decision === 'deleted' && p.decision === 'saved' && !d.jobs[`immich:${p.id}`]), '共有受付済み写真の削除は運営へご相談ください', 409);
      p.decision = decision;
      this.event(d, decision === 'saved' ? 'photo_saved' : 'photo_deleted', { sessionId, photoId, subjectCount: p.subjectCount });

      return p;
    });
  }
  respondShare(sessionId, credential, photoId, share, statementVersion, statementText) {
    return this.transaction(d => {
      const s = this.session(d, sessionId), actor = this.actor(s, credential);
      check(actor.role === 'subject', '被写体本人が回答してください', 403);
      const p = d.photos[photoId];
      check(p && p.sessionId === sessionId && p.decision === 'saved', '確認できる保存済み写真がありません', 404);
      check(p.consentSubjectIds.includes(actor.id), '撮影時に参加していた被写体のみ回答できます', 403);
      check(typeof share === 'boolean', '共有する／しないを選択してください');
      check(typeof statementVersion === 'string' && statementVersion.length > 0, '同意説明のバージョンが設定されていません', 503);
      check(typeof statementText === 'string' && statementText.trim().length > 0, '同意説明が設定されていません', 503);
      const previous = p.shareConsents[actor.id];
      if (previous) {
        check(previous.share === share, '回答済みの写真共有同意は変更できません', 409);
        return p;
      }
      p.shareConsents[actor.id] = { share, answeredAt: now(), respondentId: actor.id, statementVersion, statementText };
      const answers = p.consentSubjectIds.map(subjectId => p.shareConsents[subjectId]);
      if (answers.some(answer => answer?.share === false)) p.shareStatus = 'not-shared';
      else if (answers.every(answer => answer?.share === true)) {
        p.shareStatus = 'queued';
        p.shareConsentVersion = statementVersion;
        this.job(d, `immich:${p.id}`, { destination: 'immich', photoId, sessionId, asset: p.asset,
          status: 'pending', attempts: 0, nextAttemptAt: 0, routing: 'pending' });
      } else p.shareStatus = 'awaiting-consent';
      this.event(d, 'photo_share_consent_recorded', { sessionId, photoId, subjectId: actor.id, share });
      return p;
    });
  }
  assetPath(name) {
    check(typeof name === 'string' && /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes('..'), 'Invalid asset');
    return path.join(this.root, 'assets', name);
  }
  cleanup(ttl = 3600000, purgeOrphans = true, retentionMs = 7 * 86400000) {
    this.transaction(d => {
      for (const p of Object.values(d.photos)) {
        const age = Date.now() - Date.parse(p.capturedAt);
        const job = d.jobs[`immich:${p.id}`];
        const shareInProgress = job && job.status !== 'succeeded';
        if (p.decision === 'draft' && age > ttl) {
          p.decision = 'deleted';
          this.event(d, 'photo_deleted', { sessionId: p.sessionId, photoId: p.id, reason: 'draft_expired' });
        } else if (p.decision === 'saved' && age > retentionMs && !shareInProgress && p.shareStatus !== 'awaiting-consent') {
          p.decision = 'deleted';
          this.event(d, 'photo_deleted', { sessionId: p.sessionId, photoId: p.id, reason: 'retention_expired' });
        }
      }
    });
    const retained = new Set(Object.values(this.data.photos).filter(p => p.decision !== 'deleted').map(p => p.asset));
    for (const session of Object.values(this.data.sessions)) if (session.guide) { retained.add(session.guide.asset); retained.add(session.guide.referenceAsset); }
    for (const r of Object.values(this.data.references)) {
      if (r.status !== 'deleted') { retained.add(r.asset); for (const v of r.variants) retained.add(v.asset); }
    }
    for (const j of Object.values(this.data.jobs)) if (j.asset && !j.metadata) retained.add(j.asset);
    const deleted = new Set(Object.values(this.data.photos).filter(p => p.decision === 'deleted').map(p => p.asset));
    for (const file of fs.readdirSync(path.join(this.root, 'assets'))) {
      if (deleted.has(file) || (purgeOrphans && !retained.has(file))) fs.rmSync(this.assetPath(file), { force: true });
    }
  }
}
module.exports = { Store, check, id, token, hash, now };
