import { $, api, element, imageURL, socketUrl, draw43, blobOf, jobText } from './common.js';
let credentials = JSON.parse(localStorage.getItem('wiss-production-single-photographer') || 'null');
let state, ws, stream, draft, uploading = false, previewURL, stopped = false;
const guard = fn => async () => { $('error').textContent = ''; try { await fn(); } catch (e) { $('error').textContent = e.message; } };
const request = (path = '', opts = {}) => api(`/sessions/${credentials.sessionId}${path}`, { token: credentials.token, ...opts });
function render(s) {
  state = s;
  $('end').hidden = !s.closed && !!s.hostId;
  $('end').textContent = s.closed ? '参加画面に戻る' : 'セッションを終了';
  if (s.closed) {
    stopped = true; ws?.close(); stream?.getTracks().forEach(t => t.stop()); stream = null;
    $('connection').textContent = '撮影終了';
  }
  for (const name of ['camera', 'free']) $(name).disabled = s.closed;
  $('start').hidden = true; $('session').hidden = false;
  $('mode').textContent = s.guide && s.transform?.opacity > 0 ? 'ガイド撮影' : s.mode === 'free' ? '自由撮影 / フレームなし' : s.reference?.name || 'フレーム撮影';
  const variant = s.reference?.variants.find(v => v.id === s.activeFrameId);
  $('overlay').hidden = !variant && !s.guide;
  if (s.guide) $('overlay').src = imageURL(s.guide.imageURL, credentials.token) + '&v=' + s.guide.revision;
  if (s.transform) { for (const key of ['x', 'y', 'scale', 'opacity']) { const control = document.getElementById('guide-' + key); if (control !== document.activeElement) control.value = s.transform[key]; } $('overlay').style.transform = `translate(${s.transform.x * 100}%, ${s.transform.y * 100}%) scale(${s.transform.scale})`; $('overlay').style.opacity = s.transform.opacity; }
  if (variant) $('overlay').src = variant.imageURL;
  $('subjects').textContent = s.subjects.map((p, i) => `${i + 1}人目 ${p.connected ? '● 接続中' : '○ 未接続'}${p.id === s.representativeId ? ' / 代表者' : ''}`).join('\n') || '参加を待っています';
  $('capture').disabled = !stream || uploading || s.closed || !s.subjects.length;
  $('photos').replaceChildren(...s.photos.filter(p => p.decision === 'saved' || p.decision === 'draft').map(p => {
    const card = element('div'), img = element('img'); img.className = 'thumb'; img.alt = '撮影写真'; img.src = imageURL(p.imageURL, credentials.token); card.append(img);
    card.append(element('p', p.decision === 'draft' ? '端末へ保存する写真を確認中' : `${p.shareStatus === 'awaiting-consent' ? `公式共有の同意待ち ${p.answeredCount}/${p.consentSubjectCount}` : shareStatusText(p.shareStatus)} · ${jobText(p.jobs)}`, 'status'));
    if (p.decision === 'saved') { const download = element('button', 'この端末へダウンロード'); download.className = 'secondary'; download.onclick = () => saveToDevice(p); card.append(download); }
    if (p.decision === 'draft') { const b = element('button', '保存・削除を選ぶ'); b.onclick = () => review(p); card.append(b); }
    return card;
  }));
}
async function saveToDevice(photo) {
  const response = await fetch(photo.imageURL, { headers: { Authorization: `Bearer ${credentials.token}` }, cache: 'no-store' });
  if (!response.ok) throw new Error('写真を取得できません');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = `${photo.id}.jpg`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function connect() {
  if (stopped) return;
  ws = new WebSocket(socketUrl(credentials));
  ws.onopen = () => { $('connection').textContent = '接続中'; };
  ws.onmessage = e => { if (typeof e.data === 'string') { const p = JSON.parse(e.data); if (p.type === 'state') render(p.session); } };
  ws.onclose = e => { $('connection').textContent = '未接続'; if (e.code === 4000) { stopped = true; $('error').textContent = '別の画面で接続されました。この画面を閉じてください。'; return; } if (!stopped) setTimeout(connect, 2000); };
}
function shareStatusText(status) {
  return ({ 'not-shared': '公式共有しない', 'queued': '共有予約済み', 'uploading': 'Immichへ送信中', 'album-adding': '公式アルバム登録中', 'complete': '公式共有完了', 'retry': '再試行待ち', 'uncertain': '結果確認中', 'attention': '運営の対応が必要' })[status] || '公式共有未選択';
}
async function initialize() {
  render(await request());
  if (!state.closed) connect();
}
$('photographerCode').value = location.hash.slice(1);
history.replaceState(null, '', location.pathname + location.search);
$('join').onclick = guard(async () => { credentials = await api('/join', { method: 'POST', body: { joinCode: $('photographerCode').value.trim(), role: 'photographer' } }); stopped = false; localStorage.setItem('wiss-production-single-photographer', JSON.stringify(credentials)); await initialize(); });
$('camera').onclick = guard(async () => {
  stream?.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 } }, audio: false });
  $('video').srcObject = stream; await $('video').play(); render(state);
});
const liveCanvas = document.createElement('canvas'); let sending = false;
setInterval(async () => {
  if (!stream || sending || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 512 * 1024 || !$('video').videoWidth) return;
  sending = true;
  try { draw43($('video'), liveCanvas, 360); const blob = await blobOf(liveCanvas); if (blob && ws.readyState === WebSocket.OPEN) ws.send(blob); } finally { sending = false; }
}, 150);
function review(p) {
  draft = p; $('reviewImage').src = imageURL(p.imageURL, credentials.token);
  $('consentSummary').textContent = '端末へ保存する写真を確認してください。ここでは写真を一時保存して被写体へ渡します。端末へのダウンロードは別操作です。WISS公式アルバムには送信しません。公式共有は撮影後、各被写体が写真ごとに選びます。';
  $('reviewError').textContent = ''; $('review').showModal(); render(state);
}
$('capture').onclick = guard(async () => {
  uploading = true; render(state);
  try {
    const c = document.createElement('canvas'); draw43($('video'), c);
    const form = new FormData(); form.append('captureId', crypto.randomUUID()); form.append('expectedVersion', state.version); form.append('photo', await blobOf(c), 'capture.jpg');
    const p = await request('/photos', { method: 'POST', body: form }); review(p);
  } finally { uploading = false; render(state); }
});
async function decide(decision) {
  $('save').disabled = $('delete').disabled = true;
  try { await request(`/photos/${draft.id}/decision`, { method: 'POST', body: { decision } }); draft = null; $('review').close(); render(await request()); }
  catch (e) { $('reviewError').textContent = e.message; }
  finally { $('save').disabled = $('delete').disabled = false; }
}
$('save').onclick = () => decide('saved'); $('delete').onclick = () => decide('deleted');
$('review').addEventListener('cancel', e => e.preventDefault());
$('free').onclick = guard(async () => render(await request('/guide-transform', { method: 'PUT', body: { ...(state.transform || { x: 0, y: 0, scale: 1 }), opacity: 0 } })));

$('end').onclick = guard(async () => {
  if (!state.closed) {
    if (!confirm('撮影を終了しますか？')) return;
    await request('/close', { method: 'POST' });
  }
  stopped = true; ws?.close(); stream?.getTracks().forEach(t => t.stop());
  localStorage.removeItem('wiss-production-single-photographer'); location.reload();
});
setInterval(() => { if (credentials && !stopped && !$('review').open) request().then(render).catch(e => { $('error').textContent = e.message; }); }, 5000);
if (credentials) guard(initialize)();

for (const key of ['x', 'y', 'scale', 'opacity']) document.getElementById('guide-' + key).onchange = guard(async () => {
  const transform = Object.fromEntries(['x', 'y', 'scale', 'opacity'].map(k => [k, Number(document.getElementById('guide-' + k).value)]));
  render(await request('/guide-transform', { method: 'PUT', body: transform }));
});
