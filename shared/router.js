const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const QRCode = require('qrcode');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Store, check, id, hash, now } = require('./store');
const { Integrations } = require('./integrations');

const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
const credential = req => req.get('Authorization')?.replace(/^Bearer /, '') || req.query.token;
const KINDS = ['box', 'silhouette', 'box_face'];

function createWiss(options = {}) {
  const env = options.env || process.env;
  const store = new Store(options.root || env.WISS_DATA_DIR || path.resolve('data/wiss'), options.single ? 1 : 6);
  const retention = Number(env.WISS_RETENTION_MS || 7 * 86400000);
  store.cleanup(Number(env.WISS_DRAFT_TTL_MS || 3600000), true, retention);
  const integrations = new Integrations(store, env, options.adapters);
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 4, fields: 12 } });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const clients = new Map();
  router.use(express.json({ limit: '64kb' }));
  router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); next(); });
  function auth(req, photographer = false) {
    const s = store.session(store.data, req.params.sessionId);
    const actor = store.actor(s, credential(req));
    check(!photographer || actor.role === 'photographer', '撮影者専用です', 403);
    return { s, actor };
  }
  function secretEqual(actual, expected) {
    if (!actual || !expected) return false;
    const a = Buffer.from(String(actual)), b = Buffer.from(String(expected));
    return a.length === b.length && timingSafeEqual(a, b);
  }
  function operator(req) {
    check(env.WISS_OPERATOR_TOKEN, '運営アクセス資格が未設定です', 503);
    check(secretEqual(credential(req), env.WISS_OPERATOR_TOKEN), '運営アクセス資格が無効です', 401);
  }
  function worker(req) {
    check(env.WISS_WORKER_TOKEN, '会場ワーカー資格が未設定です', 503);
    check(secretEqual(credential(req), env.WISS_WORKER_TOKEN), '会場ワーカー資格が無効です', 401);
  }
  function jobsFor(photoId) {
    return Object.values(store.data.jobs).filter(job => job.photoId === photoId).map(job => ({ status: job.status, hasRemoteAsset: !!job.immichAssetId }));
  }
  function publicPhoto(photo, actor = null) {
    const answers = photo.consentSubjectIds.map(subjectId => photo.shareConsents?.[subjectId]).filter(Boolean);
    const ownConsent = actor?.role === 'subject' ? photo.shareConsents?.[actor.id] || null : null;
    return { id: photo.id, sessionId: photo.sessionId, capturedAt: photo.capturedAt, subjectCount: photo.subjectCount,
      consentSubjectCount: photo.consentSubjectIds?.length || 0, answeredCount: answers.length,
      agreedCount: answers.filter(answer => answer.share).length, ownShareConsent: ownConsent?.share ?? null,
      shareStatus: photo.shareStatus || 'not-shared', mode: photo.mode, eligibleForConsent: !!actor && photo.consentSubjectIds.includes(actor.id), decision: photo.decision,
      status: photo.status, referenceId: photo.referenceId, jobs: jobsFor(photo.id),
      imageURL: `/api/wiss/sessions/${photo.sessionId}/photos/${photo.id}/image` };
  }
  function state(sessionId, actor = null) {
    const s = store.session(store.data, sessionId);
    const online = [...clients.values()].filter(client => client.sessionId === sessionId);
    const publishedSession = store.publicSession(s);
    return { ...publishedSession, single: !!options.single, guide: s.guide ? { kind: s.guide.kind, imageURL: s.guide.imageURL, referenceURL: s.guide.referenceURL, revision: s.guide.revision } : null, transform: s.transform || { x: 0, y: 0, scale: 1, opacity: 0.65 }, subjects: publishedSession.subjects.map(subject => ({ ...subject, connected: online.some(client => client.actor.id === subject.id) })),
      photographerConnected: online.some(client => client.actor.role === 'photographer'),
      sharePolicy: { enabled: !!(env.WISS_SHARE_CONSENT_TEXT && env.WISS_SHARE_CONSENT_VERSION), text: env.WISS_SHARE_CONSENT_TEXT || '', version: env.WISS_SHARE_CONSENT_VERSION || '' },
      photos: Object.values(store.data.photos).filter(photo => photo.sessionId === s.id && photo.decision !== 'deleted').map(photo => publicPhoto(photo, actor)) };
  }
  function broadcast(sessionId) {
    for (const [ws, client] of clients) if (client.sessionId === sessionId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'state', session: state(sessionId, client.actor) }));
  }
  function broadcastAll() { for (const s of Object.values(store.data.sessions)) broadcast(s.id); }
  function saveAsset(buffer, ext) {
    const limit = Number(env.WISS_STORAGE_LIMIT_BYTES || 2 * 1024 * 1024 * 1024);
    if (integrations.storageUsage().bytes + buffer.length > limit) throw Object.assign(new Error('一時保存容量の上限に達しました。運営へお知らせください'), { statusCode: 507 });
    const name = `${id()}.${ext}`;
    fs.writeFileSync(store.assetPath(name), buffer, { mode: 0o600, flag: 'wx' });
    return name;
  }
  async function validateImage(file, transparent = false) {
    check(file, '画像が不足しています');
    const image = sharp(file.buffer, { limitInputPixels: 24 * 1024 * 1024 });
    const m = await image.metadata();
    check(['jpeg', 'png'].includes(m.format) && (m.pages || 1) === 1, 'JPEGまたは単一PNGを使用してください');
    check((options.single ? m.width * 4 === m.height * 3 : m.width * 3 === m.height * 4) && m.width >= 320 && m.width <= 6000, options.single ? '画像は縦3:4、幅320〜6000pxにしてください' : '画像は横4:3、幅320〜6000pxにしてください');
    check(!m.orientation || m.orientation === 1, '画像のEXIF回転を適用してから登録してください');
    if (transparent) {
      check(m.format === 'png' && m.hasAlpha, '透過PNGを使用してください');
      const stats = await image.stats();
      check(stats.channels.at(-1).min === 0 && stats.channels.at(-1).max > 0, '完全に透明な背景画素と描画の両方が必要です');
    }
    const bytes = transparent ? await image.png().toBuffer() : await image.jpeg({ quality: 95 }).toBuffer();
    return { bytes, width: m.width, height: m.height, format: m.format };
  }

  // 1:1 retains its 900x1200 guide generator and normalized viewport.
  let generatingGuide = false;
  router.post('/sessions/:sessionId/guide', (req, res, next) => { try { auth(req); check(options.single, '1対1専用です', 404); next(); } catch (e) { next(e); } }, upload.single('reference'), wrap(async (req, res) => {
    const { s, actor } = auth(req);
    check(!s.closed && actor.role === 'subject', '被写体が撮影中に操作してください', 403);
    check(!generatingGuide, 'ガイド生成中です。少し待ってください', 409);
    check(req.file && ['rectangle', 'keypoints', 'silhouette'].includes(req.body.kind), '参照写真とガイド種類を選んでください');
    generatingGuide = true;
    const files = [];
    try {
      const reference = await sharp(req.file.buffer, { limitInputPixels: 24 * 1024 * 1024 }).rotate().resize(900, 1200, { fit: 'cover' }).jpeg({ quality: 95 }).toBuffer();
      const referenceAsset = saveAsset(reference, 'jpg'); files.push(referenceAsset);
      const asset = `${id()}.png`; files.push(asset);
      const { execFile } = require('node:child_process');
      const { promisify } = require('node:util');
      await promisify(execFile)(env.WISS_PYTHON || 'python3', [path.join(options.guideBackend, 'guide_processor/generate_guide.py'), '--input', store.assetPath(referenceAsset), '--output', store.assetPath(asset), '--type', req.body.kind, '--width', '900', '--height', '1200'], { cwd: options.guideBackend, timeout: 120000, maxBuffer: 1024 * 1024 });
      check(integrations.storageUsage().bytes <= Number(env.WISS_STORAGE_LIMIT_BYTES || 2 * 1024 ** 3), '一時保存容量を超えました', 507);
      store.transaction(d => {
        const current = store.session(d, s.id); check(!current.closed, '撮影は終了しています', 409);
        current.guide = { asset, referenceAsset, kind: req.body.kind, imageURL: `/api/wiss/sessions/${s.id}/guide/image`, referenceURL: `/api/wiss/sessions/${s.id}/guide/reference`, revision: id() };
        current.transform = { x: 0, y: 0, scale: 1, opacity: 0.65 }; current.version++;
      });
      broadcast(s.id); res.json(state(s.id, actor));
    } catch (error) {
      for (const file of files) fs.rmSync(store.assetPath(file), { force: true });
      if (!error.statusCode) throw Object.assign(new Error('ガイドを生成できません。人物がはっきり写った写真、または別のガイド種類をお試しください。運営はPythonとモデル設定を確認してください'), { statusCode: 422 });
      throw error;
    } finally { generatingGuide = false; }
  }));
  router.get('/sessions/:sessionId/guide/:kind', wrap((req, res) => {
    const { s } = auth(req); check(s.guide, 'ガイドがありません', 404);
    check(['image', 'reference'].includes(req.params.kind), '画像がありません', 404);
    res.sendFile(store.assetPath(req.params.kind === 'image' ? s.guide.asset : s.guide.referenceAsset));
  }));
  router.put('/sessions/:sessionId/guide-transform', wrap((req, res) => {
    const { s, actor } = auth(req); check(options.single && !s.closed, '撮影中の1対1専用です', 409);
    const t = req.body;
    check(['x', 'y', 'scale', 'opacity'].every(k => Number.isFinite(t[k])) && Math.abs(t.x) <= 1 && Math.abs(t.y) <= 1 && t.scale >= 0.25 && t.scale <= 3 && t.opacity >= 0 && t.opacity <= 1, 'ガイド位置が不正です');
    store.transaction(d => { d.sessions[s.id].transform = { x: t.x, y: t.y, scale: t.scale, opacity: t.opacity }; d.sessions[s.id].version++; });
    broadcast(s.id); res.json(state(s.id, actor));
  }));

  router.post('/sessions', wrap((req, res) => {
    check(options.single, 'セッションはWISS Togetherアプリから作成してください', 403);
    res.status(201).json(store.createSession());
  }));
  router.post('/app/sessions', wrap((req, res) => {
    check(!options.single, 'Together専用です', 404);
    check(env.WISS_APP_CREATOR_TOKEN, '運営によるアプリ作成資格の設定が必要です', 503);
    check(secretEqual(req.get('x-wiss-app-creator'), env.WISS_APP_CREATOR_TOKEN), 'アプリの作成用資格を確認してください', 401);
    res.status(201).json(store.createSession());
  }));
  router.post('/join', wrap((req, res) => { const result = store.join(req.body.joinCode, req.body.role); broadcast(result.sessionId); res.status(201).json(result); }));
  router.get('/sessions/:sessionId', wrap((req, res) => { const { actor } = auth(req); res.json(state(req.params.sessionId, actor)); }));
  for (const action of ['representative', 'proposals', 'view', 'close', 'active-frame']) {
    router[action === 'active-frame' ? 'put' : 'post'](`/sessions/:sessionId/${action}`, wrap((req, res) => {
      store.mutate(req.params.sessionId, credential(req), action, req.body);
      broadcast(req.params.sessionId); res.json(state(req.params.sessionId, store.actor(store.data.sessions[req.params.sessionId], credential(req))));
    }));
  }
  router.get('/library', wrap((req, res) => res.json(Object.values(store.data.references).filter(ref => ref.status === 'published').map(ref => store.publicReference(ref)))));
  router.get('/library/:referenceId/:kind', wrap((req, res) => {
    const ref = store.data.references[req.params.referenceId];
    check(ref?.status === 'published', '公開中の参照素材が見つかりません', 404);
    const asset = req.params.kind === 'reference' ? ref.asset : ref.variants.find(variant => variant.kind === req.params.kind)?.asset;
    check(asset, '画像が見つかりません', 404); res.sendFile(store.assetPath(asset));
  }));
  router.post('/sessions/:sessionId/photos', (req, res, next) => { try { auth(req, true); next(); } catch (error) { next(error); } }, upload.single('photo'), wrap(async (req, res) => {
    const { s } = auth(req, true);
    const existing = Object.values(store.data.photos).find(photo => photo.sessionId === s.id && photo.captureId === req.body.captureId);
    if (existing) return res.json(publicPhoto(existing));
    const validated = await validateImage(req.file);
    const asset = saveAsset(req.file.buffer, validated.format === 'png' ? 'png' : 'jpg');
    try {
      const photo = store.capture(s.id, credential(req), { captureId: req.body.captureId, expectedVersion: Number(req.body.expectedVersion) }, asset);
      if (photo.asset !== asset) fs.rmSync(store.assetPath(asset), { force: true });
      broadcast(s.id); res.status(201).json(publicPhoto(photo));
    } catch (error) { fs.rmSync(store.assetPath(asset), { force: true }); throw error; }
  }));
  router.post('/sessions/:sessionId/photos/:photoId/decision', wrap((req, res) => {
    const { s } = auth(req);
    const photo = store.decide(s.id, credential(req), req.params.photoId, req.body.decision);
    if (photo.decision === 'deleted') fs.rmSync(store.assetPath(photo.asset), { force: true });
    broadcast(s.id); res.json(publicPhoto(photo));
  }));
  router.post('/sessions/:sessionId/photos/:photoId/share-consent', wrap((req, res) => {
    const version = String(env.WISS_SHARE_CONSENT_VERSION || '');
    check(req.body.statementVersion === version, '共有説明が更新されました。再取得して確認してください', 409);
    const photo = store.respondShare(req.params.sessionId, credential(req), req.params.photoId, req.body.share, version, env.WISS_SHARE_CONSENT_TEXT || '');
    broadcast(photo.sessionId); res.json(state(photo.sessionId, store.actor(store.data.sessions[photo.sessionId], credential(req))));
  }));
  router.get('/sessions/:sessionId/photos/:photoId/image', wrap((req, res) => {
    auth(req); const photo = store.data.photos[req.params.photoId];
    check(photo?.sessionId === req.params.sessionId && photo.decision !== 'deleted', '写真が見つかりません', 404);
    res.set('Cache-Control', 'private, no-store'); res.sendFile(store.assetPath(photo.asset));
  }));
  router.get('/sessions/:sessionId/invitations', wrap(async (req, res) => {
    const { s, actor } = auth(req);
    check(actor.id === s.hostId, '親機専用です', 403);
    const base = (env.WISS_PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');
    const joinURL = `${base}/booth/join.html#${s.joinCode}`;
    const photographerURL = options.single ? `${base}/booth/#${s.photographerJoinCode}` : joinURL;
    res.json({ joinCode: s.joinCode, photographerCode: options.single ? s.photographerJoinCode : s.joinCode,
      joinQR: await QRCode.toDataURL(joinURL), photographerQR: await QRCode.toDataURL(photographerURL) });
  }));
  router.get('/sessions/:sessionId/links', wrap(async (req, res) => {
    const { s } = auth(req, true);
    const base = (env.WISS_PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');
    const joinURL = `${base}/booth/join.html#${s.joinCode}`;
    res.json({ joinURL, joinQR: await QRCode.toDataURL(joinURL) });
  }));

  router.get('/operator/photos/:photoId/image', wrap((req, res) => {
    operator(req); const photo = store.data.photos[req.params.photoId];
    check(photo && photo.decision !== 'deleted', '写真が見つかりません', 404);
    res.set('Cache-Control', 'private, no-store').sendFile(store.assetPath(photo.asset));
  }));
  router.post('/operator/auth-check', wrap((req, res) => { operator(req); res.json({ ok: true }); }));
  router.get('/operator/dashboard', wrap((req, res) => { operator(req); res.json(integrations.dashboard()); }));
  router.post('/operator/pause', wrap((req, res) => { operator(req); store.transaction(d => { d.settings ||= {}; d.settings.sharingPaused = req.body.paused === true; }); res.json({ ok: true }); }));
  router.post('/operator/jobs/:jobId/retry', wrap((req, res) => {
    operator(req); check(integrations.retry(req.params.jobId), '共有ジョブが見つかりません', 404); broadcastAll(); res.json({ ok: true });
  }));
  router.post('/operator/jobs/:jobId/resolve', wrap((req, res) => {
    operator(req);
    const job = store.data.jobs[req.params.jobId];
    check(job?.destination === 'immich' && ['uncertain', 'attention'].includes(job.status), '運営確認が必要なジョブではありません', 409);
    if (req.body.resolution === 'already-complete') {
      store.transaction(d => { const current = d.jobs[job.id]; current.status = 'succeeded'; current.error = null; current.completedAt = now(); d.photos[current.photoId].shareStatus = 'complete'; });
    } else {
      check(req.body.resolution === 'retry', '解決方法が無効です');
      check(integrations.retry(job.id, { resolveUncertain: true }), '共有ジョブを再試行できません', 409);
    }
    broadcastAll(); res.json({ ok: true });
  }));

  // Venue worker is an outbound-only client authenticated with a worker-only credential.
  router.post('/worker/jobs/claim', wrap((req, res) => {
    worker(req); check(integrations.mode() === 'venue', '会場ワーカー配送モードではありません', 409);
    if (store.data.settings.sharingPaused || env.IMMICH_ENABLED !== 'true') return res.json({ job: null });
    let claimed;
    store.transaction(d => {
      const job = Object.values(d.jobs).find(item => item.destination === 'immich' && ['pending', 'failed'].includes(item.status) && item.nextAttemptAt <= Date.now() && item.attempts < Number(env.IMMICH_MAX_ATTEMPTS || 5));
      if (!job) return;
      const photo = d.photos[job.photoId];
      if (!photo || photo.decision !== 'saved' || photo.shareStatus !== 'queued' && photo.shareStatus !== 'retry' && photo.shareStatus !== 'uploading' && photo.shareStatus !== 'album-adding') return;
      job.status = 'running'; job.routing = 'venue'; job.workerLease = randomBytes(24).toString('base64url');
      job.workerLeaseUntil = Date.now() + Number(env.WISS_WORKER_LEASE_MS || 300000); job.attempts++;
      photo.shareStatus = job.immichAssetId ? 'album-adding' : 'uploading';
      claimed = { id: job.id, photoId: job.photoId, capturedAt: photo.capturedAt, assetId: job.immichAssetId || null, lease: job.workerLease };
    });
    if (claimed) { claimed.imageURL = `/api/wiss/worker/jobs/${encodeURIComponent(claimed.id)}/image`; res.json({ job: claimed }); }
    else res.json({ job: null });
  }));
  function workerJob(req) {
    worker(req);
    const job = store.data.jobs[req.params.jobId];
    check(job?.destination === 'immich' && job.status === 'running' && job.routing === 'venue', '処理中の会場ジョブが見つかりません', 404);
    check(job.workerLeaseUntil > Date.now() && secretEqual(req.get('x-wiss-worker-lease'), job.workerLease), '会場ジョブ資格の期限切れです', 409);
    return job;
  }
  router.get('/worker/jobs/:jobId/image', wrap((req, res) => {
    const job = workerJob(req); res.set('Cache-Control', 'private, no-store').sendFile(store.assetPath(job.asset));
  }));
  router.post('/worker/jobs/:jobId/report', wrap((req, res) => {
    const job = workerJob(req), photoStatus = req.body.stage;
    check(['asset-uploaded', 'complete', 'retry', 'uncertain', 'attention'].includes(photoStatus), '処理段階が無効です');
    store.transaction(d => {
      const current = d.jobs[job.id], photo = d.photos[current.photoId];
      if (photoStatus === 'asset-uploaded') {
        check(typeof req.body.assetId === 'string' && /^[\da-f-]{36}$/i.test(req.body.assetId), 'Immich画像IDが不正です');
        current.immichAssetId = req.body.assetId; current.duplicate = req.body.duplicate === true; photo.shareStatus = 'album-adding';
      } else if (photoStatus === 'complete') {
        check(current.immichAssetId, 'アルバム登録前に画像IDを保存してください');
        current.status = 'succeeded'; current.completedAt = now(); current.error = null; photo.shareStatus = 'complete';
      } else {
        current.status = photoStatus === 'retry' ? (current.attempts >= Number(env.IMMICH_MAX_ATTEMPTS || 5) ? 'attention' : 'failed') : photoStatus;
        current.error = String(req.body.error || '').slice(0, 180);
        current.nextAttemptAt = photoStatus === 'retry' ? Date.now() + Math.min(3600000, 5000 * (2 ** Math.max(0, current.attempts - 1))) : 0;
        photo.shareStatus = current.status === 'attention' ? 'attention' : photoStatus;
      }
      if (photoStatus !== 'complete' && photoStatus !== 'asset-uploaded') { current.workerLease = null; current.workerLeaseUntil = 0; }
    });
    broadcast(job.sessionId); res.json({ ok: true });
  }));

  // Pre-approved, prepared reference assets only; no captured event photos enter this flow.
  router.post('/operator/library', (req, res, next) => { try { operator(req); next(); } catch (error) { next(error); } }, upload.fields([{ name: 'reference', maxCount: 1 }, ...KINDS.map(kind => ({ name: kind, maxCount: 1 }))]), wrap(async (req, res) => {
    check(!options.single, '1対N専用の事前素材登録です', 404);
    check(req.body.rightsConfirmed === 'true', '事前素材を使用する権利を確認してください');
    const name = String(req.body.name || '').trim();
    check(name.length > 0 && name.length <= 100, '素材名は1〜100文字です');
    const subjectCount = Number(req.body.subjectCount);
    check(Number.isInteger(subjectCount) && subjectCount >= 1 && subjectCount <= 6, '人数は1〜6人です');
    const reference = await validateImage(req.files.reference?.[0]);
    const variants = [];
    for (const kind of KINDS) {
      const variant = await validateImage(req.files[kind]?.[0], true);
      check(variant.width === reference.width && variant.height === reference.height, '全画像を同じ寸法にしてください');
      variants.push({ ...variant, kind });
    }
    const files = [];
    try {
      const asset = saveAsset(reference.bytes, 'jpg'); files.push(asset);
      const savedVariants = variants.map(variant => { const file = saveAsset(variant.bytes, 'png'); files.push(file); return { id: id(), kind: variant.kind, asset: file }; });
      const result = store.transaction(d => {
        const internal = Object.values(d.sessions).find(session => session.internalLibrary) || { id: id(), internalLibrary: true, closed: true, subjects: [], proposals: [], version: 0, activeFrameId: null, mode: 'free', createdAt: now() };
        d.sessions[internal.id] = internal;
        const ref = { id: id(), name, subjectCount, origin: 'prepared', asset, variants: savedVariants, width: reference.width, height: reference.height, status: 'published', createdAt: now() };
        d.references[ref.id] = ref; return ref;
      });
      broadcastAll(); res.status(201).json(store.publicReference(result));
    } catch (error) { for (const file of files) fs.rmSync(store.assetPath(file), { force: true }); throw error; }
  }));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.statusCode || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
    res.status(status).json({ error: error.statusCode ? error.message : error.code === 'LIMIT_FILE_SIZE' ? '画像容量の上限を超えました' : 'リクエストを処理できません' });
  });

  function upgrade(req, socket, head) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId');
      const s = store.session(store.data, sessionId), actor = store.actor(s, url.searchParams.get('token'));
      check(!s.closed, 'Session closed', 403);
      wss.handleUpgrade(req, socket, head, ws => {
        for (const [old, client] of clients) if (client.sessionId === sessionId && client.actor.id === actor.id) { clients.delete(old); old.close(4000, 'Reconnected'); }
        clients.set(ws, { sessionId, actor }); ws.alive = true;
        ws.on('pong', () => { ws.alive = true; });
        ws.on('message', (bytes, binary) => {
          if (store.data.sessions[sessionId].closed) return ws.close(1000, 'Session ended');
          if (!binary || actor.role !== 'photographer' || bytes.length > 1024 * 1024) return;
          for (const [target, client] of clients) if (client.sessionId === sessionId && client.actor.role === 'subject' && target.readyState === WebSocket.OPEN && target.bufferedAmount < 512 * 1024) target.send(bytes, { binary: true });
        });
        ws.on('error', () => {}); ws.on('close', () => { clients.delete(ws); broadcast(sessionId); }); broadcast(sessionId);
      });
    } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  }
  const timer = options.noWorker ? null : setInterval(() => integrations.tick().then(broadcastAll).catch(() => console.error('Immich queue error')), 3000);
  timer?.unref();
  const maintenance = options.noWorker ? null : setInterval(() => {
    try { store.cleanup(Number(env.WISS_DRAFT_TTL_MS || 3600000), false, retention); } catch (error) { console.error('Photo retention error:', error.message); }
    store.transaction(d => {
      for (const job of Object.values(d.jobs)) if (job.destination === 'immich' && job.status === 'running' && job.routing === 'venue' && job.workerLeaseUntil < Date.now()) {
        job.status = job.immichAssetId ? (job.attempts >= Number(env.IMMICH_MAX_ATTEMPTS || 5) ? 'attention' : 'failed') : 'uncertain'; job.error = job.immichAssetId ? '会場ワーカーが停止。アルバム登録を再開できます' : '会場ワーカー停止後の送信結果を確認してください';
        const photo = d.photos[job.photoId]; if (photo) photo.shareStatus = job.status === 'attention' ? 'attention' : job.immichAssetId ? 'retry' : 'uncertain'; job.workerLease = null;
      }
    });
    for (const ws of clients.keys()) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 30000);
  maintenance?.unref();
  return { router, upgrade, store, integrations, broadcast, close() { clearInterval(timer); clearInterval(maintenance); for (const ws of clients.keys()) ws.terminate(); wss.close(); } };
}
module.exports = { createWiss };
