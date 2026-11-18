const fs = require('node:fs');
const path = require('node:path');

function validateConfig(config) {
  const base = String(config?.url || '').trim().replace(/\/+$/, '');
  if (!base || !config?.apiKey || !config?.albumId) throw Object.assign(new Error('ImmichのURL・APIキー・公式アルバムIDが未設定です'), { code: 'NOT_CONFIGURED' });
  let parsed;
  try { parsed = new URL(base); } catch { throw Object.assign(new Error('Immich URLが不正です'), { code: 'CONFIG' }); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error('Immich URLは資格情報・クエリのないHTTP(S) URLで指定してください'), { code: 'CONFIG' });
  }
  if (!/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(config.albumId)) {
    throw Object.assign(new Error('公式アルバムIDの形式が不正です'), { code: 'CONFIG' });
  }
  const apiBase = base;
  return { ...config, url: base, apiBase };
}

async function jsonResponse(response) {
  let text;
  try { text = await response.text(); } catch { throw Object.assign(new Error('Immich応答の受信が中断しました'), { uncertain: true }); }
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const error = new Error(`Immich API HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!body || typeof body !== 'object') throw Object.assign(new Error('Immich APIの応答を確認できません'), { uncertain: true });
  return body;
}

async function uploadAsset(configInput, filePath, photoId, capturedAt, timeoutMs = 30000) {
  const config = validateConfig(configInput);
  const inMemory = Buffer.isBuffer(filePath);
  if (!inMemory && !fs.statSync(filePath).isFile()) throw new Error('写真ファイルがありません');
  const bytes = inMemory ? filePath : fs.readFileSync(filePath);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const filename = inMemory ? `${photoId}.${png ? 'png' : 'jpg'}` : path.basename(filePath);
  const form = new FormData();
  form.append('assetData', new Blob([bytes], { type: png ? 'image/png' : 'image/jpeg' }), filename);
  form.append('deviceAssetId', `wiss-${photoId}`);
  form.append('deviceId', 'wiss-challenge');
  form.append('fileCreatedAt', new Date(capturedAt).toISOString());
  form.append('fileModifiedAt', new Date(capturedAt).toISOString());
  form.append('filename', filename);
  let response;
  try {
    response = await fetch(`${config.apiBase}/assets`, {
      method: 'POST', headers: { 'x-api-key': config.apiKey }, redirect: 'error', body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw Object.assign(new Error('Immichへの送信結果を確認できません'), { uncertain: true, cause: error });
  }
  const body = await jsonResponse(response);
  if (!['created', 'duplicate'].includes(body.status) || body.success === false || typeof body.id !== 'string' || !/^[\da-f-]{36}$/i.test(body.id)) {
    throw Object.assign(new Error('Immichが画像を受け付けませんでした'), { uncertain: true });
  }
  // Duplicate responses refer to an existing asset. It is never deleted by this client.
  return { id: body.id, duplicate: body.status === 'duplicate' };
}

async function addToAlbum(configInput, assetId, timeoutMs = 30000) {
  const config = validateConfig(configInput);
  let response;
  try {
    response = await fetch(`${config.apiBase}/albums/assets`, {
      method: 'PUT', redirect: 'error', headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ albumIds: [config.albumId], assetIds: [assetId] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw Object.assign(new Error('アルバム登録の結果を確認できません'), { uncertain: true, cause: error });
  }
  const body = await jsonResponse(response);
  if (body.success !== true || body.error) throw Object.assign(new Error('Immichのアルバム登録に失敗しました'), { status: 422 });
  return { id: assetId };
}

async function uploadAndAdd(config, filePath, photoId, capturedAt, options = {}) {
  let asset = options.assetId ? { id: options.assetId, duplicate: false } : await uploadAsset(config, filePath, photoId, capturedAt, options.timeoutMs);
  await addToAlbum(config, asset.id, options.timeoutMs);
  return asset;
}

module.exports = { validateConfig, uploadAsset, addToAlbum, uploadAndAdd };
