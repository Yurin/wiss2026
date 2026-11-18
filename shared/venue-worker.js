const { uploadAsset, addToAlbum, validateConfig } = require('./immich-client');

const backend = String(process.env.WISS_BACKEND_URL || '').replace(/\/+$/, '');
const workerToken = process.env.WISS_WORKER_TOKEN;
const config = { url: process.env.IMMICH_API_URL, apiKey: process.env.IMMICH_API_KEY, albumId: process.env.IMMICH_ALBUM_ID };
const pollMs = Number(process.env.WISS_WORKER_POLL_MS || 3000);
const timeoutMs = Number(process.env.IMMICH_TIMEOUT_MS || 30000);
if (!backend || !workerToken) throw new Error('WISS_BACKEND_URLとWISS_WORKER_TOKENが必要です');

async function call(path, body, lease = null, method = 'POST') {
  const response = await fetch(`${backend}/api/wiss${path}`, { method,
    headers: { Authorization: `Bearer ${workerToken}`, ...(lease ? { 'x-wiss-worker-lease': lease } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Backend HTTP ${response.status}: ${data.error || 'request failed'}`);
  return data;
}
async function report(job, stage, extra = {}) {
  return call(`/worker/jobs/${encodeURIComponent(job.id)}/report`, { stage, ...extra }, job.lease);
}
async function processJob(job) {
  try {
    let assetId = job.assetId;
    if (!assetId) {
      const imageURL = `${backend}/api/wiss/worker/jobs/${encodeURIComponent(job.id)}/image`;
      const response = await fetch(imageURL, { headers: { Authorization: `Bearer ${workerToken}`, 'x-wiss-worker-lease': job.lease }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw Object.assign(new Error(`写真取得に失敗しました: HTTP ${response.status}`), { hard: response.status < 500 && response.status !== 429 });
      const bytes = Buffer.from(await response.arrayBuffer());
      const filename = `${job.photoId}.jpg`;
      const uploaded = await uploadAsset(config, bytes, job.photoId, job.capturedAt, timeoutMs);
      assetId = uploaded.id;
      try { await report(job, 'asset-uploaded', { assetId, duplicate: uploaded.duplicate }); } catch { throw Object.assign(new Error('画像IDの保存結果を確認できません'), { uncertain: true }); }
    }
    await addToAlbum(config, assetId, timeoutMs);
    try { await report(job, 'complete'); } catch { throw Object.assign(new Error('共有完了の報告結果を確認できません'), { uncertain: true }); }
    console.log(`shared ${job.photoId}`);
  } catch (error) {
    const stage = error.uncertain ? 'uncertain' : (error.hard || error.code || (error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408)) ? 'attention' : 'retry';
    try { await report(job, stage, { error: String(error.message).slice(0, 160) }); }
    catch (reportError) { console.error('Could not report worker result:', reportError.message); }
    console.error(`job ${job.id}: ${error.message}`);
  }
}
async function poll() {
  try { validateConfig(config); } catch { console.error('Immich設定待ち'); setTimeout(poll, pollMs); return; }
  try { const result = await call('/worker/jobs/claim'); if (result.job) await processJob(result.job); }
  catch (error) { console.error('Worker poll failed:', error.message); }
  setTimeout(poll, pollMs);
}
console.log('WISS venue worker started; it only opens outbound connections to the backend and Immich.');
poll();
