const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('wiss-operator-token') || '';
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api/wiss/operator${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function button(text, action, className = 'secondary') {
  const element = document.createElement('button'); element.textContent = text; element.className = className;
  element.onclick = async () => { $('error').textContent = ''; try { await action(); } catch (error) { $('error').textContent = error.message; } };
  return element;
}
async function refresh() {
  const data = await api('/dashboard'); $('login').hidden = true; $('dashboard').hidden = false;
  $('readiness').textContent = `連携設定: ${data.configured ? '準備済み' : '未設定'} / 送信先: ${{ backend: 'バックエンド', venue: '会場ワーカー', hold: '保留' }[data.mode]} / 送信: ${!data.enabled ? '連携無効' : data.paused ? '一時停止中' : data.mode === 'hold' ? '保留' : '稼働'}`;
  $('counts').textContent = `共有予約・再試行 ${data.counts.waiting} / 送信中 ${data.counts.uploading} / 完了 ${data.counts.complete} / 結果確認中 ${data.counts.uncertain} / 要対応 ${data.counts.attention}`;
  $('storage').textContent = `一時保存容量 ${(data.storage.bytes / 1024 / 1024).toFixed(1)} MiB / ${(data.storage.limitBytes / 1024 / 1024).toFixed(0)} MiB / 保持期限超過 ${data.storage.overduePhotos}枚`;
  $('pauseButton').textContent = data.paused ? '共有を再開' : '共有を一時停止';
  $('pauseButton').onclick = async () => { await api('/pause', 'POST', { paused: !data.paused }); await refresh(); };
  $('jobs').replaceChildren();
  for (const job of data.jobs.filter(item => ['failed', 'attention', 'uncertain'].includes(item.status))) {
    const row = document.createElement('article'); row.className = 'card';
    const label = document.createElement('p'); label.textContent = `${job.photoId} / ${job.status} / 試行 ${job.attempts}${job.error ? ` / ${job.error}` : ''}`; row.append(label);
    if (job.immichAssetId) { const remote = document.createElement('p'); remote.textContent = `Immich画像ID: ${job.immichAssetId}${job.duplicate ? '（既存画像）' : ''}`; row.append(remote); }
    row.append(button('写真を確認', async () => {
      const response = await fetch(`/api/wiss/operator/photos/${encodeURIComponent(job.photoId)}/image`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!response.ok) throw new Error('写真を取得できません');
      const url = URL.createObjectURL(await response.blob());
      const img = document.createElement('img'); img.alt = '要確認の写真'; img.className = 'thumb'; img.style.maxWidth = '360px'; img.onload = () => URL.revokeObjectURL(url); img.src = url; row.append(img);
    }));
    if (job.status !== 'uncertain') row.append(button('失敗を再試行', async () => { await api(`/jobs/${encodeURIComponent(job.id)}/retry`, 'POST', {}); await refresh(); }, ''));
    if (job.status === 'uncertain') {
      row.append(button('Immich側を確認済み：共有完了', async () => { await api(`/jobs/${encodeURIComponent(job.id)}/resolve`, 'POST', { resolution: 'already-complete' }); await refresh(); }));
      row.append(button('確認済み：再送・アルバム再登録', async () => { await api(`/jobs/${encodeURIComponent(job.id)}/resolve`, 'POST', { resolution: 'retry' }); await refresh(); }));
    }
    $('jobs').append(row);
  }
  if (!$('jobs').childElementCount) $('jobs').textContent = '要確認の共有ジョブはありません。';
}
async function login() {
  token = $('operatorToken').value.trim();
  try { await api('/auth-check', 'POST', {}); sessionStorage.setItem('wiss-operator-token', token); $('error').textContent = ''; await refresh(); }
  catch (error) { token = ''; $('error').textContent = error.message; }
}
$('loginButton').onclick = login;
$('refreshButton').onclick = () => refresh().catch(error => { $('error').textContent = error.message; });
if (token) refresh().catch(() => { sessionStorage.removeItem('wiss-operator-token'); token = ''; });
setInterval(() => { if (token) refresh().catch(error => { $('error').textContent = error.message; }); }, 15000);
