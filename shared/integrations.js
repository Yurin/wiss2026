const path = require('node:path');
const { uploadAsset, addToAlbum, validateConfig } = require('./immich-client');

const transient = error => error?.uncertain || !error?.status || error.status >= 500 || error.status === 429 || error.status === 408;
const summary = error => error?.code === 'NOT_CONFIGURED' ? 'Immich設定待ち' : String(error?.message || 'Immich処理に失敗しました').slice(0, 180);

class Integrations {
  constructor(store, env = process.env, adapters = {}) {
    this.store = store;
    this.env = env;
    this.adapters = adapters;
    this.running = false;
  }
  config() {
    return { url: this.env.IMMICH_API_URL, apiKey: this.env.IMMICH_API_KEY, albumId: this.env.IMMICH_ALBUM_ID };
  }
  configured() {
    try { validateConfig(this.config()); return true; } catch { return false; }
  }
  mode() { return ['backend', 'venue', 'hold'].includes(this.env.IMMICH_DELIVERY_MODE) ? this.env.IMMICH_DELIVERY_MODE : 'hold'; }
  update(jobId, values) {
    this.store.transaction(d => {
      const job = d.jobs[jobId];
      if (!job) return;
      Object.assign(job, values);
      const photo = d.photos[job.photoId];
      if (photo) photo.shareStatus = values.photoStatus || job.status;
    });
  }
  async tick() {
    if (this.running || this.store.data.settings?.sharingPaused || this.mode() !== 'backend' || this.env.IMMICH_ENABLED !== 'true') return;
    this.running = true;
    try {
      const jobs = Object.values(this.store.data.jobs).filter(job => job.destination === 'immich' &&
        ['pending', 'failed'].includes(job.status) && job.nextAttemptAt <= Date.now() && job.attempts < Number(this.env.IMMICH_MAX_ATTEMPTS || 5));
      for (const original of jobs) { if (this.store.data.settings?.sharingPaused) break; await this.process(original.id); }
    } finally { this.running = false; }
  }
  async process(jobId) {
    let job = this.store.data.jobs[jobId];
    if (!job || !['pending', 'failed'].includes(job.status)) return;
    try { validateConfig(this.config()); } catch (error) {
      this.update(jobId, error.code === 'NOT_CONFIGURED' ? { status: 'pending', routing: 'waiting-config', error: null, photoStatus: 'queued' } : { status: 'attention', error: summary(error), photoStatus: 'attention' });
      return;
    }
    this.update(jobId, { status: 'running', routing: 'backend', attempts: job.attempts + 1, error: null, photoStatus: job.immichAssetId ? 'album-adding' : 'uploading' });
    job = this.store.data.jobs[jobId];
    const photo = this.store.data.photos[job.photoId];
    const file = this.store.assetPath(job.asset);
    try {
      if (!job.immichAssetId) {
        const uploaded = this.adapters.upload ? await this.adapters.upload(job, file) : await uploadAsset(this.config(), file, job.photoId, photo.capturedAt, Number(this.env.IMMICH_TIMEOUT_MS || 30000));
        this.update(jobId, { immichAssetId: uploaded.id, duplicate: !!uploaded.duplicate, photoStatus: 'album-adding' });
      }
      job = this.store.data.jobs[jobId];
      if (this.adapters.addToAlbum) await this.adapters.addToAlbum(job);
      else await addToAlbum(this.config(), job.immichAssetId, Number(this.env.IMMICH_TIMEOUT_MS || 30000));
      this.update(jobId, { status: 'succeeded', error: null, completedAt: new Date().toISOString(), photoStatus: 'complete' });
    } catch (error) {
      const attempts = this.store.data.jobs[jobId].attempts;
      const stage = this.store.data.jobs[jobId].immichAssetId ? 'album-add' : 'upload';
      if (error?.uncertain) {
        this.update(jobId, { status: 'uncertain', stage, error: summary(error), photoStatus: 'uncertain' });
      } else if (!transient(error)) {
        this.update(jobId, { status: 'attention', stage, error: summary(error), photoStatus: 'attention' });
      } else if (attempts >= Number(this.env.IMMICH_MAX_ATTEMPTS || 5)) {
        this.update(jobId, { status: 'attention', stage, error: summary(error), photoStatus: 'attention' });
      } else {
        this.update(jobId, { status: 'failed', stage, error: summary(error), nextAttemptAt: Date.now() + Math.min(3600000, 5000 * (2 ** (attempts - 1))), photoStatus: 'retry' });
      }
    }
  }
  retry(jobId, { resolveUncertain = false } = {}) {
    const job = this.store.data.jobs[jobId];
    if (!job || job.destination !== 'immich' || !['failed', 'attention', ...(resolveUncertain ? ['uncertain'] : [])].includes(job.status)) return false;
    this.store.transaction(d => {
      const current = d.jobs[jobId];
      Object.assign(current, { status: 'pending', attempts: 0, nextAttemptAt: 0, error: null });
      if (resolveUncertain && !current.immichAssetId) current.photoStatus = 'uncertain';
      else current.photoStatus = current.immichAssetId ? 'album-adding' : 'queued';
      if (d.photos[current.photoId]) d.photos[current.photoId].shareStatus = current.photoStatus;
    });
    return true;
  }
  dashboard() {
    const jobs = Object.values(this.store.data.jobs).filter(job => job.destination === 'immich');
    const count = status => jobs.filter(job => status.includes(job.status)).length;
    const photoById = this.store.data.photos;
    return {
      enabled: this.env.IMMICH_ENABLED === 'true', configured: this.configured(), mode: this.mode(), paused: !!this.store.data.settings?.sharingPaused,
      counts: { waiting: count(['pending', 'failed']), uploading: count(['running']), complete: count(['succeeded']), uncertain: count(['uncertain']), attention: count(['attention']) },
      jobs: jobs.map(job => ({ id: job.id, photoId: job.photoId, sessionId: job.sessionId, status: job.status,
        photoStatus: photoById[job.photoId]?.shareStatus || job.status, attempts: job.attempts, nextAttemptAt: job.nextAttemptAt,
        error: job.error || null, hasRemoteAsset: !!job.immichAssetId, immichAssetId: job.immichAssetId || null, duplicate: !!job.duplicate, capturedAt: photoById[job.photoId]?.capturedAt || null })),
      storage: this.storageUsage(),
    };
  }
  storageUsage() {
    const directory = path.join(this.store.root, 'assets');
    let bytes = 0;
    for (const file of require('node:fs').readdirSync(directory)) {
      try { bytes += require('node:fs').statSync(path.join(directory, file)).size; } catch { /* Removed during cleanup. */ }
    }
    return { bytes, overduePhotos: Object.values(this.store.data.photos).filter(p => p.decision !== 'deleted' && Date.now() - Date.parse(p.capturedAt) > Number(this.env.WISS_RETENTION_MS || 7 * 86400000)).length, limitBytes: Number(this.env.WISS_STORAGE_LIMIT_BYTES || 2 * 1024 * 1024 * 1024) };
  }
}
module.exports = { Integrations };
