import { $, api, element, imageURL, socketUrl } from './common.js';
const key = 'wiss-production-multi-subject';
let credentials; try { credentials = JSON.parse(localStorage.getItem(key) || 'null'); } catch { localStorage.removeItem(key); }
let state, socket, stopped = false, liveURL, library = [], librarySignature = '', photoSignature = '', busy = false;
const request = (path = '', options = {}) => api(`/sessions/${credentials.sessionId}${path}`, { token: credentials.token, ...options });
const status = p => ({ 'not-shared': '未共有', 'awaiting-consent': `同意待ち ${p.agreedCount}/${p.consentSubjectCount}人`, queued: '共有予約済み', uploading: '写真送信中', 'album-adding': 'アルバム登録中', complete: '共有完了', retry: '再試行待ち', uncertain: '結果確認中（共有済みの可能性があります）', attention: '運営の対応が必要' })[p.shareStatus] || '確認中';
function button(label, action) {
  const b = element('button', label);
  b.onclick = async () => { if (busy) return; busy = true; b.disabled = true; $('error').textContent = ''; try { await action(); } catch (e) { $('error').textContent = e.message; } finally { busy = false; b.disabled = false; } };
  return b;
}
async function mutate(action, body, method = 'POST') { await request('/' + action, { method, body }); await refresh(); }
function image(path, alt) { const img = element('img'); img.className = 'thumb'; img.alt = alt; img.src = path; return img; }
function render(s) {
  state = s; $('session').hidden = false;
  $('title').textContent = s.closed ? '撮影が終了しました' : s.reference?.name || '自由撮影';
  $('members').textContent = `被写体 ${s.subjects.length}/6人 · ${s.representativeId === credentials.subjectId ? 'あなたが代表者です' : '被写体として参加中'}`;
  $('reference').hidden = !s.reference; if (s.reference) $('reference').src = s.reference.imageURL;
  const variant = s.reference?.variants.find(v => v.id === s.activeFrameId);
  $('overlay').hidden = !variant; if (variant) $('overlay').src = variant.imageURL;
  $('frameSection').hidden = s.closed; $('free').hidden = s.closed || s.representativeId !== credentials.subjectId;
  if (s.closed) { stopped = true; socket?.close(); $('live').hidden = true; $('connection').textContent = '撮影終了 · 写真と共有状況は引き続き確認できます'; }
  const nextLibrary = JSON.stringify([s.representativeId, s.proposals, s.subjects, library]);
  if (nextLibrary !== librarySignature) {
    librarySignature = nextLibrary; $('library').replaceChildren(); $('proposals').replaceChildren(); $('representative').replaceChildren();
    for (const p of s.proposals) {
      const row = element('p', `${p.name} の提案`);
      if (s.representativeId === credentials.subjectId) row.append(button('この提案を確定', () => mutate('active-frame', { frameId: p.frameId, expectedVersion: state.version }, 'PUT')));
      $('proposals').append(row);
    }
    if (!library.length) $('library').append(element('p', '事前フレームは未登録です。自由撮影できます。'));
    for (const ref of library) {
      const card = element('article'); card.append(image(ref.imageURL, ref.name), element('h3', `${ref.name} · ${ref.subjectCount}人`));
      for (const v of ref.variants) {
        const row = element('div'); row.append(image(v.imageURL, v.kind));
        row.append(button(`${({box:'人物枠',silhouette:'シルエット',box_face:'人物枠＋顔位置'})[v.kind] || v.kind}を提案`, () => mutate('proposals', { frameId: v.id })));
        if (s.representativeId === credentials.subjectId) row.append(button('このフレームを確定', () => mutate('active-frame', { frameId: v.id, expectedVersion: state.version }, 'PUT')));
        card.append(row);
      }
      $('library').append(card);
    }
    if (s.representativeId === credentials.subjectId) {
      const select = element('select'); select.setAttribute('aria-label', '次の代表者');
      s.subjects.forEach((p, i) => { const o = element('option', `${i + 1}人目`); o.value = p.id; select.append(o); });
      select.value = s.representativeId;
      $('representative').append(select, button('代表者を変更', () => mutate('representative', { subjectId: select.value, expectedVersion: state.version })));
    }
  }
  const nextPhotos = JSON.stringify([s.photos, s.sharePolicy]);
  if (photoSignature === nextPhotos) return;
  photoSignature = nextPhotos; $('photos').replaceChildren();
  if (!s.photos.length) $('photos').append(element('p', '撮影した写真がここに届きます。'));
  for (const p of s.photos) {
    const card = element('article'); card.append(image(imageURL(p.imageURL, credentials.token), '撮影写真'), element('p', status(p)));
    if (p.decision !== 'saved') { card.append(element('p', '撮影者が確認中')); $('photos').append(card); continue; }
    card.append(button('端末に保存', async () => {
      const response = await fetch(p.imageURL, { headers: { Authorization: `Bearer ${credentials.token}` }, cache: 'no-store' });
      if (!response.ok) throw new Error('写真を取得できません');
      const url = URL.createObjectURL(await response.blob()); const a = element('a'); a.href = url; a.download = `${p.id}.jpg`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    }));
    card.append(element('p', 'iPhoneで写真が開いた場合は、共有メニューから「画像を保存」を選べます。', 'muted'));
    if (['not-shared', 'awaiting-consent'].includes(p.shareStatus)) card.append(button('一時保存から削除', async () => { if (confirm('全員の写真一覧から削除しますか？')) await mutate(`photos/${p.id}/decision`, { decision: 'deleted' }); }));
    if (s.sharePolicy?.enabled && p.eligibleForConsent && p.ownShareConsent === null) {
      card.append(element('p', s.sharePolicy.text));
      for (const [label, share] of [['WISS公式アルバムに共有する', true], ['共有しない', false]]) card.append(button(label, () => mutate(`photos/${p.id}/share-consent`, { share, statementVersion: s.sharePolicy.version })));
      card.append(element('p', '撮影時の被写体全員が同意した写真だけ共有します。回答しなくても次の撮影へ進めます。'));
    } else if (p.ownShareConsent !== null) card.append(element('p', p.ownShareConsent ? 'あなたは共有に同意済み' : 'あなたは共有しないと回答済み'));
    else card.append(element('p', p.eligibleForConsent ? '公式共有の説明は未設定です。' : '撮影時に参加した被写体が共有を選びます。'));
    $('photos').append(card);
  }
}
async function refresh() { if (credentials) render(await request()); }
function connect() {
  if (stopped) return;
  const ws = new WebSocket(socketUrl(credentials)); socket = ws;
  ws.onopen = () => { $('connection').textContent = '接続中'; };
  ws.onmessage = e => {
    if (typeof e.data === 'string') { const data = JSON.parse(e.data); if (data.type === 'state') render(data.session); }
    else { if (liveURL) URL.revokeObjectURL(liveURL); liveURL = URL.createObjectURL(e.data); $('live').src = liveURL; $('live').hidden = false; }
  };
  ws.onclose = e => { if (e.code === 4000) { stopped = true; $('connection').textContent = '別の画面で接続されました'; } if (!stopped) { $('connection').textContent = '再接続中'; setTimeout(connect, 2000); } };
}
$('refresh').onclick = () => refresh().catch(e => { $('error').textContent = e.message; });
$('free').onclick = () => mutate('active-frame', { frameId: null, expectedVersion: state.version }, 'PUT').catch(e => { $('error').textContent = e.message; });
$('reset').onclick = () => { if (confirm('写真の保存・共有確認を終えましたか？リセットすると再接続資格を失います。')) { stopped = true; socket?.close(); localStorage.removeItem(key); location.href = 'join.html'; } };
if (!credentials) { $('missing').hidden = false; $('connection').textContent = ''; }
else {
  (async () => { library = await api('/library'); await refresh(); if (!stopped) connect(); })().catch(e => { $('error').textContent = e.message; });
  setInterval(() => { if (!busy) refresh().catch(e => { $('error').textContent = e.message; }); }, 4000);
}
