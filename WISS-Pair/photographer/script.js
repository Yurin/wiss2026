const video = document.getElementById("video");
const guide = document.getElementById("guide");
const cameraStage = document.querySelector(".camera-stage");
const gridOverlay = document.getElementById("gridOverlay");
const opacitySlider = document.getElementById("opacitySlider");
const toggleGridBtn = document.getElementById("toggleGridBtn");
const toggleGuideBtn = document.getElementById("toggleGuideBtn");
const captureBtn = document.getElementById("captureBtn");
const canvas = document.getElementById("canvas");
const thumbnailContainer = document.getElementById("thumbnailContainer");
const photoCount = document.getElementById("photoCount");
const sendBtn = document.getElementById("sendBtn");
const endCaptureBtn = document.getElementById("endCaptureBtn");
const shareLiveBtn = document.getElementById("shareLiveBtn");
const viewGalleryBtn = document.getElementById("viewGalleryBtn");
const closeGalleryBtn = document.getElementById("closeGalleryBtn");
const gallerySummary = document.getElementById("gallerySummary");
const galleryEmptyMessage = document.getElementById("galleryEmptyMessage");
const photoPreviewOverlay = document.getElementById("photoPreviewOverlay");
const previewImage = document.getElementById("previewImage");
const closePreviewBtn = document.getElementById("closePreviewBtn");
const postSendDialog = document.getElementById("postSendDialog");
const continueCaptureBtn = document.getElementById("continueCaptureBtn");
const finishCaptureBtn = document.getElementById("finishCaptureBtn");
const capturePanel = document.getElementById("capturePanel");
const galleryPanel = document.getElementById("galleryPanel");
const thankYouPanel = document.getElementById("thankYouPanel");
const sessionEndMessage = document.getElementById("sessionEndMessage");
const retryEndSendBtn = document.getElementById("retryEndSendBtn");
const errorPanel = document.getElementById("errorPanel");
const supportPanel = document.getElementById("supportPanel");
const supportMessage = document.getElementById("supportMessage");
const roleGuidancePanel = document.getElementById("roleGuidancePanel");
const roleGuidancePhoto = document.getElementById("roleGuidancePhoto");
const analysisState = document.getElementById("analysisState");
const photographerGuidanceList = document.getElementById("photographerGuidanceList");
const framingReady = document.getElementById("framingReady");
const poseReady = document.getElementById("poseReady");
const captureReady = document.getElementById("captureReady");
const guideControls = document.querySelectorAll(".guide-control");
const status = document.querySelector(".status");
const referenceThumbnail = document.getElementById("referenceThumbnail");
let referenceThumbnailUrl = null;

function setReferenceThumbnail(url) {
  const nextUrl = url || null;
  if (referenceThumbnailUrl === nextUrl) return;
  referenceThumbnailUrl = nextUrl;
  referenceThumbnail.hidden = true;
  referenceThumbnail.onload = () => { referenceThumbnail.hidden = false; };
  referenceThumbnail.onerror = () => { referenceThumbnail.hidden = true; };
  referenceThumbnail.src = nextUrl || "";
}

const API_BASE_PATH = "/api";
const DRAFT_UPLOAD_TIMEOUT_MS = 20000;
const PHOTO_SHARE_TIMEOUT_MS = 30000;
const PHOTO_FALLBACK_UPLOAD_TIMEOUT_MS = 60000;

let selectedPhotoIndex = null;

let showGuide = true;
let showGrid = true;
let currentStream = null;
// 撮影済み写真は、表示用画像と下書きphotoId・解析状態を一体で管理する。
let photos = [];
let latestCapturedClientId = null;
let isSendingPhotos = false;
let sessionId = "";
let wsVideo = null;
let wsSession = null;
let shareActive = false;
let liveInterval = null;
let videoSocketClosedByUser = false;
let videoReconnectTimer = null;
let videoFrameInFlight = false;
let guideUrlOverride = null;
let reconnectTimer = null;
let sessionSocketClosedByUser = false;
let guideTransform = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  opacity: 0.5,
};
let supportMessageTimer = null;
let activeGuideId = null;
let verifiedGuideIds = new Set();
let latestRoleGuidance = null;
let captureSequence = 0;
let latestDisplayedCaptureSequence = null;
let sessionEndRequested = false;
let activePhotoSendPromise = null;
let pendingPostSendResolve = null;
const shareCanvas = document.createElement("canvas");

function shortenSessionId(value) {
  if (!value) return "";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function setStatus(text) {
  status.textContent = text;
  status.title = text;
}

function setConnectionState(state) {
  const labels = {
    connecting: "接続中",
    connected: "接続済み",
    disconnected: "切断",
    reconnecting: "再接続中",
  };

  setStatus(
    sessionId
      ? `セッション: ${shortenSessionId(sessionId)} - ${labels[state]}`
      : labels[state]
  );
}

function showError(message) {
  errorPanel.textContent = message;
  errorPanel.hidden = false;
}

function clearError() {
  errorPanel.textContent = "";
  errorPanel.hidden = true;
}

function showActionHint(message) {
  errorPanel.textContent = message;
  errorPanel.hidden = false;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`通信が${Math.round(timeoutMs / 1000)}秒以内に完了しませんでした`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function shouldRetryResponse(response) {
  return response.status === 408 || response.status === 429 || response.status >= 500;
}

async function fetchWithRetry(url, options, {
  timeoutMs = 30000,
  attempts = 2,
} = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (!shouldRetryResponse(response) || attempt === attempts) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }

  throw lastError || new Error("通信に失敗しました");
}

function showSupportMessage(message, options = {}) {
  supportMessage.textContent = message;
  supportPanel.hidden = false;

  clearTimeout(supportMessageTimer);
  if (options.autoHideMs) {
    supportMessageTimer = setTimeout(() => {
      supportPanel.hidden = true;
      supportMessage.textContent = "";
    }, options.autoHideMs);
  }
}

function photographerGuidanceEnabled() {
  return true;
}

function nowTimestamp() {
  return Date.now();
}

function captureSequenceStorageKey() {
  return `photoGuideCaptureSequence:${sessionId}`;
}

function restoreCaptureSequence() {
  const storedSequence = Number(localStorage.getItem(captureSequenceStorageKey()));
  captureSequence = Number.isSafeInteger(storedSequence) && storedSequence >= 0
    ? storedSequence
    : 0;
}

function nextCaptureSequence() {
  captureSequence += 1;
  localStorage.setItem(captureSequenceStorageKey(), String(captureSequence));
  return captureSequence;
}

function recordForAnalysisPayload(payload) {
  return photos.find((item) =>
    (payload.photoId && item.draftPhotoId === payload.photoId) ||
    (payload.clientId && item.clientId === payload.clientId) ||
    (Number.isFinite(Number(payload.captureSequence)) &&
      item.captureSequence === Number(payload.captureSequence))
  );
}

function latestActiveCaptureSequence() {
  return photos.reduce(
    (latest, item) => item.deleted ? latest : Math.max(latest, item.captureSequence),
    -1
  );
}

function shouldDisplayAnalysisPayload(payload, record) {
  const payloadSequence = Number(payload.captureSequence ?? record?.captureSequence);
  return Boolean(
    record &&
    !record.deleted &&
    Number.isFinite(payloadSequence) &&
    payloadSequence >= latestActiveCaptureSequence() &&
    (latestDisplayedCaptureSequence === null || payloadSequence >= latestDisplayedCaptureSequence) &&
    (!payload.guideId || payload.guideId === activeGuideId)
  );
}

function displayCompletedAnalysis(record, payload) {
  if (!photographerGuidanceEnabled() || payload.guidanceSuppressed || !shouldDisplayAnalysisPayload(payload, record)) return false;
  const timestamp = nowTimestamp();
  const analysisId = payload.analysisId || record.analysisId || null;
  latestDisplayedCaptureSequence = record.captureSequence;
  record.displayTimestamp = record.displayTimestamp || timestamp;
  record.webGuidanceDisplayTimestamp = record.webGuidanceDisplayTimestamp || timestamp;
  record.displayedAnalysisId = analysisId;
  renderRoleGuidance(payload);
  return true;
}

function updateReadyChip(element, label, value) {
  const known = typeof value === "boolean";
  element.textContent = `${label} ${known ? (value ? "OK" : "調整中") : "—"}`;
  element.classList.toggle("is-ready", value === true);
}

function renderRoleGuidance(payload = latestRoleGuidance) {
  latestRoleGuidance = payload || null;
  if (!payload || !photographerGuidanceEnabled()) {
    roleGuidancePanel.hidden = true;
    return;
  }

  roleGuidancePanel.hidden = false;
  roleGuidancePhoto.textContent = payload.photoId ? `写真: ${payload.photoId}` : "";
  const resolved = (payload.guidanceProgress || []).filter((p) => p.wasSelected && p.newlyResolved && p.targetRole === "photographer").length;
  analysisState.textContent = payload.analysisState || (resolved ? "前の修正が完了 → 次の修正" : "現在の修正");
  photographerGuidanceList.innerHTML = "";

  const guidance = Array.isArray(payload.photographerGuidance)
    ? payload.photographerGuidance
    : [];
  const messages = guidance.length > 0
    ? guidance
    : [{ message: payload.errorMessage || (payload.ready?.framingReady ? "構図はOKです" : "解析できませんでした"), severity: "low" }];
  messages.forEach((item) => {
    const row = document.createElement("li");
    row.textContent = item.message;
    row.dataset.severity = item.severity || "low";
    photographerGuidanceList.appendChild(row);
  });

  updateReadyChip(framingReady, "構図", payload.ready?.framingReady);
  updateReadyChip(poseReady, "ポーズ", payload.ready?.poseReady);
  updateReadyChip(captureReady, "撮影", payload.ready?.captureReady);
}

function showAnalysisProgress(photoId = null) {
  renderRoleGuidance({
    photoId,
    photographerGuidance: [{ message: "撮影した写真を解析しています…", severity: "low" }],
    ready: {},
    analysisState: "解析中",
  });
}

function showAnalysisWaiting(photoId = null) {
  renderRoleGuidance({
    photoId,
    photographerGuidance: [{ message: "解析の準備をしています…", severity: "low" }],
    ready: {},
    analysisState: "解析待ち",
  });
}

function showAnalysisSkipped(photoId, message) {
  renderRoleGuidance({
    photoId,
    photographerGuidance: [{ message, severity: "low" }],
    ready: {},
    analysisState: "解析スキップ",
  });
}

function showAnalysisFailure(photoId = null, errorReason = null) {
  renderRoleGuidance({
    photoId,
    photographerGuidance: [],
    ready: {},
    analysisState: "解析失敗",
    errorMessage: errorReason ? `解析できませんでした: ${errorReason}` : "解析できませんでした",
  });
}

function applySessionGuide(guideState) {
  if (!guideState) return;
  const nextGuideId = guideState.guideId || null;
  if (activeGuideId !== nextGuideId) {
    latestRoleGuidance = null;
    roleGuidancePanel.hidden = true;
    verifiedGuideIds.clear();
  }
  activeGuideId = nextGuideId;
  setReferenceThumbnail(guideState.referenceImageUrl || (nextGuideId
    ? `${API_BASE_PATH}/guides/${encodeURIComponent(nextGuideId)}/reference?sessionId=${encodeURIComponent(sessionId)}`
    : null));
  if (guideState.url) applyGuideUrl(guideState.url);
}

function makeWsUrl(path, params) {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams(params).toString();
  return `${wsProtocol}//${window.location.host}${path}?${query}`;
}

function loadSessionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const sessionParam = params.get("sessionId")?.trim();

  if (sessionParam) {
    sessionId = sessionParam;

    restoreCaptureSequence();
    setConnectionState("connecting");
    connectSessionSocket();
    guideControls.forEach(element => { element.hidden = false; });
    updateSessionGuide();
    updatePhotoCount();
  } else {
    setStatus("セッションIDがありません");
    showError("セッションIDがありません。被写体側のQRコードから開いてください。");
  }
}

function connectSessionSocket(isReconnect = false) {
  if (!sessionId) return;
  if (wsSession && [WebSocket.CONNECTING, WebSocket.OPEN].includes(wsSession.readyState)) return;

  clearTimeout(reconnectTimer);
  sessionSocketClosedByUser = false;
  setConnectionState(isReconnect ? "reconnecting" : "connecting");

  wsSession = new WebSocket(makeWsUrl("/ws/session", { sessionId }));

  wsSession.addEventListener("open", () => {
    clearError();
    setConnectionState("connected");

  });

  wsSession.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);

      if (payload.type === "guide-updated" && payload.guide?.url) {
        applySessionGuide(payload.guide);
      }

      if (payload.type === "guide-transform" && payload.transform) {
        applyGuideTransform(payload.transform);
        showSupportMessage("ガイドが調整されました。", { autoHideMs: 2500 });
      }

      if (payload.type === "analysisStarted") {
        const record = recordForAnalysisPayload(payload);
        if (record) {
          record.analysisId = payload.analysisId || record.analysisId;
          record.analysisStatus = "analyzing";
          record.analysisStartTimestamp = payload.analysisStartTimestamp || record.analysisStartTimestamp;
          record.analysisStartedReceivedTimestamp = nowTimestamp();

          if (shouldDisplayAnalysisPayload(payload, record)) {
            showAnalysisProgress(record.draftPhotoId);
          }
        }
      }

      if (payload.type === "roleGuidanceUpdated") {
        const record = recordForAnalysisPayload(payload);
        if (record) {
          record.analysisId = payload.analysisId || record.analysisId;
          record.analysisPayload = payload;
          record.analysisStatus = payload.analysisStatus || "completed";
          record.analysisStartTimestamp = payload.analysisStartTimestamp || record.analysisStartTimestamp;
          record.analysisEndTimestamp = payload.analysisEndTimestamp || record.analysisEndTimestamp;
          record.analysisCompletedReceivedTimestamp = nowTimestamp();

          displayCompletedAnalysis(record, payload);
        }
      }

      if (payload.type === "analysisFailed") {
        const record = recordForAnalysisPayload(payload);
        if (record) {
          record.analysisId = payload.analysisId || record.analysisId;
          record.analysisStatus = "failed";
          record.analysisStartTimestamp = payload.analysisStartTimestamp || record.analysisStartTimestamp;
          record.analysisEndTimestamp = payload.analysisEndTimestamp || record.analysisEndTimestamp;
          record.analysisFailedReceivedTimestamp = nowTimestamp();
          record.errorReason = payload.errorReason || "analysis failed";

          if (shouldDisplayAnalysisPayload(payload, record)) {
            showAnalysisFailure(record.draftPhotoId, record.errorReason);
          }
        }
      }

      if (payload.type === "session-ended") {
        void handleSessionEnded();
      }

      if (payload.type === "session-deleted") {
        guideUrlOverride = null;
        activeGuideId = null;
        verifiedGuideIds.clear();
        latestRoleGuidance = null;
        latestDisplayedCaptureSequence = null;
        roleGuidancePanel.hidden = true;
        guide.removeAttribute("src");
        guide.hidden = true;
        guideTransform = {
          offsetX: 0,
          offsetY: 0,
          scale: 1,
          opacity: 0.5,
        };
        applyGuideTransform(guideTransform);
        showSupportMessage("セッションの保存データが削除されました。", { autoHideMs: 3000 });
        photos = [];
        updateThumbnails();
        updatePhotoCount();
        showError("このセッションの保存データは削除されました。");
      }
    } catch (error) {
      console.error("session message parse error", error);
    }
  });

  wsSession.addEventListener("close", () => {
    wsSession = null;
    if (sessionSocketClosedByUser) {
      setConnectionState("disconnected");
      return;
    }

    setConnectionState("disconnected");

    showError("サーバーとの接続が切断されました。再接続を試みます。");
    reconnectTimer = setTimeout(() => {
      connectSessionSocket(true);
    }, 2000);
  });

  wsSession.addEventListener("error", () => {
    showError("サーバーに接続できません。ネットワークまたはサーバーの起動状態を確認してください。");
  });
}

function disconnectSessionSocket() {
  sessionSocketClosedByUser = true;
  clearTimeout(reconnectTimer);
  if (wsSession) {
    wsSession.close(1000);
    wsSession = null;
  }
}

function connectVideoSocket() {
  if (!sessionId || !shareActive || sessionEndRequested) return;
  if (wsVideo && [WebSocket.CONNECTING, WebSocket.OPEN].includes(wsVideo.readyState)) return;

  clearTimeout(videoReconnectTimer);
  videoSocketClosedByUser = false;
  const socket = new WebSocket(makeWsUrl("/ws/video", {
    sessionId,
    role: "sender",
  }));
  wsVideo = socket;
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    if (wsVideo !== socket) return;
    if (!shareActive) {
      disconnectVideoSocket();
      return;
    }

    clearError();
    setStatus(`セッション: ${sessionId} - ライブ接続済み`);
    shareLiveBtn.textContent = "停止";

    if (liveInterval) {
      clearInterval(liveInterval);
    }
    sendVideoFrame();
    liveInterval = setInterval(sendVideoFrame, 250);
  });

  socket.addEventListener("close", () => {
    if (wsVideo !== socket) return;
    wsVideo = null;
    stopVideoFrameLoop();

    if (videoSocketClosedByUser || !shareActive || sessionEndRequested) {
      setConnectionState(wsSession?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
      return;
    }

    shareLiveBtn.textContent = "再接続中";
    showError("ライブ共有の接続が切断されました。再接続を試みます。");
    scheduleVideoReconnect();
  });

  socket.addEventListener("error", () => {
    if (wsVideo !== socket) return;
    if (!videoSocketClosedByUser) {
      showError("ライブ共有用の接続に失敗しました。サーバーとの接続を確認してください。");
    }
  });
}

function disconnectVideoSocket() {
  videoSocketClosedByUser = true;
  clearTimeout(videoReconnectTimer);
  videoReconnectTimer = null;
  if (wsVideo) {
    wsVideo.close(1000);
    wsVideo = null;
  }
}

function stopVideoFrameLoop() {
  if (liveInterval) {
    clearInterval(liveInterval);
    liveInterval = null;
  }
  videoFrameInFlight = false;
}

function scheduleVideoReconnect() {
  if (!shareActive || videoSocketClosedByUser || sessionEndRequested) return;
  clearTimeout(videoReconnectTimer);
  videoReconnectTimer = setTimeout(() => {
    videoReconnectTimer = null;
    connectVideoSocket();
  }, 2000);
}

function sendVideoFrame() {
  if (wsVideo?.readyState === WebSocket.CONNECTING) return;

  if (!wsVideo || wsVideo.readyState !== WebSocket.OPEN) {
    if (shareActive) {
      scheduleVideoReconnect();
    }
    return;
  }
  if (!video.videoWidth || !video.videoHeight || videoFrameInFlight) return;
  if (wsVideo.bufferedAmount > 512 * 1024) return;

  try {
    videoFrameInFlight = true;
    const socket = wsVideo;
    const width = 320;
    const height = Math.round(width * 4 / 3);
    const sourceRect = centeredSourceRect(video.videoWidth, video.videoHeight, 3 / 4);

    shareCanvas.width = width;
    shareCanvas.height = height;

    const ctx = shareCanvas.getContext("2d");
    ctx.drawImage(
      video,
      sourceRect.x,
      sourceRect.y,
      sourceRect.width,
      sourceRect.height,
      0,
      0,
      width,
      height
    );

    shareCanvas.toBlob((blob) => {
      if (!blob || wsVideo !== socket || socket.readyState !== WebSocket.OPEN) {
        videoFrameInFlight = false;
        return;
      }
      blob.arrayBuffer()
        .then((buffer) => {
          if (wsVideo === socket && socket.readyState === WebSocket.OPEN) {
            socket.send(buffer);
          }
        })
        .catch((error) => {
          console.error("ArrayBuffer conversion error:", error);
          showError("ライブ映像の送信準備に失敗しました。");
        })
        .finally(() => {
          videoFrameInFlight = false;
        });
    }, "image/jpeg", 0.6);
  } catch (error) {
    videoFrameInFlight = false;
    console.error("Error in sendVideoFrame:", error);
    showError("ライブ映像の送信に失敗しました。");
  }
}

function centeredSourceRect(sourceWidth, sourceHeight, targetAspect) {
  const sourceAspect = sourceWidth / sourceHeight;

  if (sourceAspect > targetAspect) {
    const width = sourceHeight * targetAspect;
    return {
      x: (sourceWidth - width) / 2,
      y: 0,
      width,
      height: sourceHeight,
    };
  }

  const height = sourceWidth / targetAspect;
  return {
    x: 0,
    y: (sourceHeight - height) / 2,
    width: sourceWidth,
    height,
  };
}

function startLiveShare() {
  if (!sessionId) {
    showActionHint(
      "『ライブ共有』は、被写体側のセッションにカメラ映像を送るボタンです。まずは被写体側のQRコードからこの画面を開いてください。"
    );
    return;
  }

  if (!video.srcObject) {
    showActionHint(
      "『ライブ共有』を使うには、まずカメラを起動してください。端末のカメラ権限を許可すると、ここでライブ共有を開始できます。"
    );
    return;
  }

  clearError();
  shareActive = true;
  shareLiveBtn.textContent = "停止";
  connectVideoSocket();
}

function stopLiveShare(shouldCloseSocket = true) {
  shareActive = false;
  stopVideoFrameLoop();
  if (shouldCloseSocket) {
    disconnectVideoSocket();
  }
}

function resetCapturedPhotos({ preserveGuidance = true } = {}) {
  photos = [];
  selectedPhotoIndex = null;
  if (!preserveGuidance) {
    latestCapturedClientId = null;
    latestRoleGuidance = null;
    roleGuidancePanel.hidden = true;
  }
  updateThumbnails();
  updatePhotoCount();
}

async function removeDraftFromServer(record) {
  if (!record.draftPhotoId || record.draftStatus === "shared") return;
  try {
    await fetch(
      `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/draft-photos/${encodeURIComponent(record.draftPhotoId)}`,
      { method: "DELETE" }
    );
  } catch (error) {
    console.error("draft photo deletion failed", {
      photoId: record.draftPhotoId,
      error,
    });
  }
}

async function deleteDraftPhoto(record) {
  record.deleted = true;
  await removeDraftFromServer(record);
}

function refreshLatestGuidance() {
  const latest = photos[photos.length - 1] || null;
  latestCapturedClientId = latest?.clientId || null;
  if (latest && latest.guideId !== activeGuideId) {
    latestRoleGuidance = null;
    roleGuidancePanel.hidden = true;
    return;
  }
  if (latest?.analysisPayload) {
    renderRoleGuidance(latest.analysisPayload);
  } else if (latest?.analysisStatus === "waiting") {
    showAnalysisWaiting(latest.draftPhotoId);
  } else if (latest?.analysisStatus === "analyzing") {
    showAnalysisProgress(latest.draftPhotoId);
  } else if (latest?.analysisStatus === "failed") {
    showAnalysisFailure(latest.draftPhotoId);
  } else if (latest?.analysisStatus === "skippedMissingGuide") {
    showAnalysisSkipped(latest.draftPhotoId, "guideIdがないため解析をスキップしました");
  } else if (latest?.analysisStatus === "skippedMissingReferenceGuide") {
    showAnalysisSkipped(
      latest.draftPhotoId,
      "ReferenceGuideがないため解析をスキップしました"
    );
  } else if (!latest) {
    latestRoleGuidance = null;
    roleGuidancePanel.hidden = true;
  } else {
    roleGuidancePanel.hidden = true;
  }
}

function finishCaptureAfterSend() {
  void handleSessionEnded();
}

function askPostSendAction() {
  return new Promise((resolve) => {
    postSendDialog.hidden = false;

    const cleanup = (action) => {
      postSendDialog.hidden = true;
      pendingPostSendResolve = null;
      continueCaptureBtn.removeEventListener("click", continueHandler);
      finishCaptureBtn.removeEventListener("click", finishHandler);
      resolve(action);
    };

    const continueHandler = () => cleanup("continue");
    const finishHandler = () => cleanup("finish");

    continueCaptureBtn.addEventListener("click", continueHandler);
    finishCaptureBtn.addEventListener("click", finishHandler);
    pendingPostSendResolve = cleanup;
  });
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
      },
      audio: false,
    });

    currentStream = stream;
    video.srcObject = stream;

  } catch (error) {
    console.error(error);
    showActionHint(
      "カメラを起動できませんでした。権限を許可してから、画面上の『ライブ共有』や『撮影』をお試しください。"
    );

  }
}

opacitySlider.addEventListener("input", (e) => {
  guideTransform.opacity = Number(e.target.value);
  applyGuideTransform(guideTransform);

});

toggleGuideBtn.addEventListener("click", () => {
  showGuide = !showGuide;
  guide.hidden = !showGuide || !guideUrlOverride;

});

toggleGridBtn.addEventListener("click", () => {
  showGrid = !showGrid;
  gridOverlay.hidden = !showGrid;
  toggleGridBtn.textContent = showGrid ? "▦" : "□";
  const label = showGrid ? "グリッド線を消す" : "グリッド線を出す";
  toggleGridBtn.setAttribute("aria-label", label);
  toggleGridBtn.title = label;

});

shareLiveBtn.addEventListener("click", () => {
  if (shareActive) {
    stopLiveShare();
    shareLiveBtn.textContent = "ライブ共有";
    setConnectionState(wsSession?.readyState === WebSocket.OPEN ? "connected" : "disconnected");

  } else {
    startLiveShare();

  }
});

captureBtn.addEventListener("click", async () => {
  if (sessionEndRequested || isSendingPhotos) return;
  if (!video.videoWidth || !video.videoHeight) {
    showActionHint(
      "『撮影』はカメラ映像が見えてから使えます。映像が表示されるまで少し待ってから、もう一度押してください。"
    );
    return;
  }

  const outputWidth = 900;
  const outputHeight = 1200;
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const ctx = canvas.getContext("2d");
  const targetAspect = outputWidth / outputHeight;
  const sourceRect = centeredSourceRect(video.videoWidth, video.videoHeight, targetAspect);

  ctx.drawImage(
    video,
    sourceRect.x,
    sourceRect.y,
    sourceRect.width,
    sourceRect.height,
    0,
    0,
    outputWidth,
    outputHeight
  );

  const imageUrl = canvas.toDataURL("image/jpeg", 0.92);
  const captureTimestamp = nowTimestamp();
  const record = {
    clientId: crypto.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    imageUrl,
    captureSequence: nextCaptureSequence(),
    captureTimestamp,
    draftPhotoId: null,
    draftStatus: "uploading",
    deleted: false,
    uploadPromise: null,
    analysisPromise: null,
    analysisStatus: "waiting",
    analysisStartTimestamp: null,
    analysisEndTimestamp: null,
    analysisId: null,
    draftSaveStartTimestamp: null,
    draftSaveEndTimestamp: null,
    analysisStartedReceivedTimestamp: null,
    analysisCompletedReceivedTimestamp: null,
    analysisFailedReceivedTimestamp: null,
    displayTimestamp: null,
    webGuidanceDisplayTimestamp: null,
    displayedAnalysisId: null,
    analysisPayload: null,
    errorReason: null,
    guideId: activeGuideId,
    guideTransform: {
      translationX: guideTransform.offsetX,
      translationY: guideTransform.offsetY,
      scale: guideTransform.scale,
    },
  };
  photos.push(record);
  latestCapturedClientId = record.clientId;
  updateThumbnails();
  updatePhotoCount();

  if (photographerGuidanceEnabled()) {
    if (record.guideId) {
      showAnalysisWaiting();
    } else {
      record.analysisStatus = "skippedMissingGuide";
      record.errorReason = "guideIdMissing";
      showAnalysisSkipped(null, "guideIdがないため解析をスキップしました");
    }
  }

  record.uploadPromise = uploadDraftAndAnalyze(record);
});

function updatePhotoCount() {
  photoCount.textContent = `${photos.length}枚`;
  sendBtn.disabled = photos.length === 0 || !sessionId;
  gallerySummary.textContent = `撮影済み写真 ${photos.length}枚`;
  updateGalleryButton();
  galleryEmptyMessage.hidden = photos.length > 0;
}

function updateGalleryButton() {
  if (photos.length === 0) {
    viewGalleryBtn.textContent = "撮影済み写真はありません";
    viewGalleryBtn.disabled = true;
    viewGalleryBtn.classList.add("disabled");
  } else {
    viewGalleryBtn.textContent = `撮影済み写真 ${photos.length}枚`;
    viewGalleryBtn.disabled = false;
    viewGalleryBtn.classList.remove("disabled");
  }
}

function showCaptureView() {
  galleryPanel.hidden = true;
  capturePanel.hidden = false;
  photoPreviewOverlay.hidden = true;
}

function openGallery() {
  updateThumbnails();
  gallerySummary.textContent = `撮影済み写真 ${photos.length}枚`;
  galleryEmptyMessage.hidden = photos.length > 0;
  capturePanel.hidden = true;
  galleryPanel.hidden = false;
  window.scrollTo(0, 0);
}

function closeGallery() {
  galleryPanel.hidden = true;
  capturePanel.hidden = false;
}

function applyGuideUrl(url) {
  if (guideUrlOverride === url) return;

  guideUrlOverride = url;
  guide.src = url;
  guide.hidden = !showGuide;
  applyGuideTransform(guideTransform);
  clearError();
  setStatus(`セッション: ${sessionId} - ガイド更新`);
}

function applyGuideTransform(transform) {
  const offsetX = Number(transform.offsetX ?? 0);
  const offsetY = Number(transform.offsetY ?? 0);
  const scale = Number(transform.scale ?? 1);
  const opacity = Number(transform.opacity ?? guideTransform.opacity);

  guideTransform = {
    offsetX: Math.max(-0.5, Math.min(0.5, offsetX)),
    offsetY: Math.max(-0.5, Math.min(0.5, offsetY)),
    scale: Math.max(0.5, Math.min(1.8, scale)),
    opacity: Math.max(0, Math.min(1, opacity)),
  };

  opacitySlider.value = guideTransform.opacity;
  guide.style.opacity = String(guideTransform.opacity);
  const stageWidth = cameraStage?.clientWidth || guide.clientWidth || 0;
  const stageHeight = cameraStage?.clientHeight || guide.clientHeight || 0;
  const translateX = guideTransform.offsetX * stageWidth;
  const translateY = guideTransform.offsetY * stageHeight;
  guide.style.transform = `translate(${translateX}px, ${translateY}px) scale(${guideTransform.scale})`;
}

window.addEventListener("resize", () => {
  applyGuideTransform(guideTransform);
});

async function updateSessionGuide() {
  if (!sessionId) return;

  try {
    const response = await fetch(`${API_BASE_PATH}/session/${encodeURIComponent(sessionId)}/guide`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (data.success && data.guide?.url) {
      applySessionGuide(data.guide);
    }
  } catch (error) {
    console.error("guide fetch error", error);
    showError("ガイド画像を取得できませんでした。サーバーとの接続を確認してください。");
  }
}

async function ensureReferenceGuide(guideId) {
  if (!guideId) {
    return false;
  }
  if (verifiedGuideIds.has(guideId)) return true;

  try {
    const response = await fetch(
      `${API_BASE_PATH}/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`
    );
    if (!response.ok) {
      console.info("Role-Aware analysis skipped: ReferenceGuide is not available", {
        guideId,
        status: response.status,
      });
      return false;
    }
    verifiedGuideIds.add(guideId);
    return true;
  } catch (error) {
    console.info("Role-Aware analysis skipped: ReferenceGuide lookup failed", error);
    return false;
  }
}

function displayForLatestRecord(record, callback) {
  if (
    !record.deleted &&
    record.captureSequence >= latestActiveCaptureSequence() &&
    record.guideId === activeGuideId
  ) {
    callback();
  }
}

async function analyzeCapturedRecord(record) {
  if (!record.guideId) {
    record.analysisStatus = "skippedMissingGuide";
    record.errorReason = "guideIdMissing";

    return;
  }

  if (!(await ensureReferenceGuide(record.guideId))) {
    record.analysisStatus = "skippedMissingReferenceGuide";
    record.errorReason = "referenceGuideMissing";
    displayForLatestRecord(record, () => {
      showAnalysisSkipped(record.draftPhotoId, "ReferenceGuideがないため解析をスキップしました");
    });

    return;
  }

  record.analysisStatus = "analyzing";
  record.analysisStartTimestamp = nowTimestamp();
  displayForLatestRecord(record, () => showAnalysisProgress(record.draftPhotoId));

  try {
    const response = await fetch(
      `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(record.draftPhotoId)}/analyze`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guideId: record.guideId,
          clientId: record.clientId,
          captureSequence: record.captureSequence,
          captureTimestamp: record.captureTimestamp,
          guideTransform: record.guideTransform,
        }),
      }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    record.analysisId = result.analysisId || record.analysisId;
    record.analysisStartTimestamp = result.analysisStartTimestamp || record.analysisStartTimestamp;
    record.analysisEndTimestamp = result.analysisEndTimestamp || nowTimestamp();
    record.analysisStatus = result.analysisStatus || "completed";
    record.analysisPayload = result;
    displayCompletedAnalysis(record, result);

  } catch (error) {
    record.analysisEndTimestamp = nowTimestamp();
    record.analysisStatus = "failed";
    record.errorReason = record.errorReason || error.message;
    console.error("Role-Aware photo analysis failed", {
      photoId: record.draftPhotoId,
      error,
    });
    displayForLatestRecord(record, () => showAnalysisFailure(record.draftPhotoId));

  }
}

async function uploadDraftAndAnalyze(record) {
  if (!sessionId) {
    record.draftStatus = "failed";
    record.analysisStatus = "failed";
    record.errorReason = "sessionIdMissing";
    displayForLatestRecord(record, () => showAnalysisFailure());

    return;
  }

  try {
    record.draftStatus = "uploading";
    record.errorReason = null;
    record.draftSaveStartTimestamp = nowTimestamp();

    const formData = new FormData();
    formData.append("clientId", record.clientId);
    formData.append("captureSequence", String(record.captureSequence));
    formData.append("captureTimestamp", record.captureTimestamp);
    formData.append("guideId", record.guideId || "");
    formData.append("guideTransform", JSON.stringify(record.guideTransform));
    formData.append("draft", dataURLtoBlob(record.imageUrl), "captured_photo.jpg");
    const response = await fetchWithRetry(
      `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/draft-photos`,
      { method: "POST", body: formData },
      { timeoutMs: DRAFT_UPLOAD_TIMEOUT_MS, attempts: 2 }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    record.draftSaveEndTimestamp = nowTimestamp();
    record.draftPhotoId = result.photo?.photoId || null;
    record.draftStatus = record.draftPhotoId ? "ready" : "failed";

    if (record.deleted) {
      await deleteDraftPhoto(record);
      return;
    }
    if (record.analysisStatus === "skippedCondition") return;
    record.analysisPromise = analyzeCapturedRecord(record);
  } catch (error) {
    record.draftSaveEndTimestamp = nowTimestamp();
    record.draftStatus = "failed";
    record.analysisStatus = "failed";
    record.errorReason = `draftUploadFailed:${error.message}`;
    console.error("captured photo draft upload failed", error);
    displayForLatestRecord(record, () => showAnalysisFailure());

  }
}

function updateThumbnails() {
  thumbnailContainer.innerHTML = "";
  thumbnailContainer.hidden = photos.length === 0;

  photos.forEach((record, index) => {
    const thumbnail = document.createElement("button");
    thumbnail.type = "button";
    thumbnail.className = "thumbnail";
    if (selectedPhotoIndex === index) {
      thumbnail.classList.add("selected");
    }
    thumbnail.setAttribute("aria-label", `写真 ${index + 1} をプレビュー`);

    const img = document.createElement("img");
    img.src = record.imageUrl;
    img.alt = `撮影した写真 ${index + 1}`;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "thumbnail-delete";
    deleteBtn.textContent = "×";
    deleteBtn.type = "button";
    deleteBtn.setAttribute("aria-label", `写真 ${index + 1} を削除`);
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (sessionEndRequested || isSendingPhotos) {
        showActionHint("写真の送信準備中は削除できません。少し待ってからお試しください。");
        return;
      }
      if (selectedPhotoIndex === index) {
        selectedPhotoIndex = null;
      } else if (selectedPhotoIndex !== null && selectedPhotoIndex > index) {
        selectedPhotoIndex -= 1;
      }
      const [deletedRecord] = photos.splice(index, 1);
      void deleteDraftPhoto(deletedRecord);
      updateThumbnails();
      updatePhotoCount();
      if (deletedRecord.clientId === latestCapturedClientId) {
        refreshLatestGuidance();
      }

    });

    thumbnail.addEventListener("click", () => {
      selectedPhotoIndex = index;
      updateThumbnails();
      showPhotoPreview(index);
    });

    thumbnail.appendChild(img);
    thumbnail.appendChild(deleteBtn);
    thumbnailContainer.appendChild(thumbnail);
  });
}

function showPhotoPreview(index) {
  selectedPhotoIndex = index;
  previewImage.src = photos[index].imageUrl;
  photoPreviewOverlay.hidden = false;
}

function closePhotoPreview() {
  photoPreviewOverlay.hidden = true;
  previewImage.src = "";
}

viewGalleryBtn.addEventListener("click", () => {
  if (photos.length === 0) {
    showActionHint("まだ撮影済みの写真がありません。");
    return;
  }
  openGallery();
});
closeGalleryBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closeGallery();
});
closePreviewBtn.addEventListener("click", closePhotoPreview);
photoPreviewOverlay.addEventListener("click", (event) => {
  if (event.target === photoPreviewOverlay) {
    closePhotoPreview();
  }
});

endCaptureBtn.addEventListener("click", () => {
  void handleSessionEnded();
});

async function waitForDraftUploads(records, label = "送信準備中") {
  let completed = 0;
  sendBtn.textContent = `${label} (0/${records.length})...`;

  await Promise.allSettled(
    records.map(async (record) => {
      try {
        await record.uploadPromise;
      } finally {
        completed += 1;
        sendBtn.textContent = `${label} (${completed}/${records.length})...`;
      }
    })
  );
}

async function sendCapturedPhotos({ promptAfterSend = true } = {}) {
  if (activePhotoSendPromise) return activePhotoSendPromise;

  if (photos.length === 0) {
    if (promptAfterSend) {
      showActionHint(
        "『送信』は撮影した写真をサーバーに送るボタンです。まず『撮影』で写真を1枚以上保存してください。"
      );
    }
    return !promptAfterSend;
  }
  if (!sessionId) {
    if (promptAfterSend) {
      showActionHint(
        "『送信』にはセッションが必要です。被写体側のQRコードからこの画面を開いてください。"
      );
    }
    return false;
  }

  isSendingPhotos = true;
  sendBtn.disabled = true;
  sendBtn.textContent = "送信準備中...";

  activePhotoSendPromise = (async () => {
    try {
      const recordsToSend = [...photos];
      await waitForDraftUploads(recordsToSend);

      const failedDrafts = recordsToSend.filter(
        (record) => record.draftStatus !== "ready" || !record.draftPhotoId
      );
      if (failedDrafts.length > 0) {
        failedDrafts.forEach((record) => {
          record.draftStatus = "uploading";
          record.uploadPromise = uploadDraftAndAnalyze(record);
        });
        await waitForDraftUploads(failedDrafts, "失敗した写真を再送中");
      }

      sendBtn.textContent = "送信中...";

      const canPromoteDrafts = recordsToSend.every(
        (record) => record.draftStatus === "ready" && record.draftPhotoId
      );
      let response;
      if (canPromoteDrafts) {
        response = await fetchWithRetry(
          `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/photos/share`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              photoIds: recordsToSend.map((record) => record.draftPhotoId),
              clientTimestamp: new Date().toISOString(),
            }),
          },
          { timeoutMs: PHOTO_SHARE_TIMEOUT_MS, attempts: 2 }
        );
      } else {
        console.info("draft promotion unavailable; falling back to the existing photo upload flow");
        const formData = new FormData();
        formData.append("sessionId", sessionId);
        recordsToSend.forEach((record, index) => {
          formData.append("photos", dataURLtoBlob(record.imageUrl), `photo_${index}.jpg`);
        });
        response = await fetchWithTimeout(
          `${API_BASE_PATH}/photos`,
          {
            method: "POST",
            body: formData,
          },
          PHOTO_FALLBACK_UPLOAD_TIMEOUT_MS
        );
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const result = await response.json();
      if (canPromoteDrafts) {
        recordsToSend.forEach((record) => { record.draftStatus = "shared"; });
      } else {
        recordsToSend
          .filter((record) => record.draftPhotoId)
          .forEach((record) => { void removeDraftFromServer(record); });
      }
      clearError();

      let nextAction = "finish";
      if (promptAfterSend && !sessionEndRequested) {
        nextAction = await askPostSendAction();
      }
      // Keep any photos captured while this batch was being sent for the next batch.
      photos = photos.filter((record) => !recordsToSend.includes(record));
      selectedPhotoIndex = null;
      updateThumbnails();
      updatePhotoCount();

      if (promptAfterSend && !sessionEndRequested) {
        if (nextAction === "finish") {
          finishCaptureAfterSend();
        } else {
          showSupportMessage("送信済み写真をリセットしました。続けて撮影できます。", { autoHideMs: 3000 });
        }
      }
      return true;
    } catch (error) {
      console.error(error);
      showError(`写真の送信に失敗しました。${error.message}。もう一度お試しください。`);

      return false;
    } finally {
      isSendingPhotos = false;
      sendBtn.disabled = photos.length === 0 || sessionEndRequested;
      sendBtn.textContent = "送信";
      activePhotoSendPromise = null;
    }
  })();

  return activePhotoSendPromise;
}

function showThankYouPage(sendFailed = false) {
  capturePanel.hidden = true;
  galleryPanel.hidden = true;
  photoPreviewOverlay.hidden = true;
  postSendDialog.hidden = true;
  thankYouPanel.hidden = false;
  document.getElementById("sessionEndTitle").textContent = sendFailed
    ? "写真を送信できませんでした"
    : "撮影へのご協力ありがとうございました";
  sessionEndMessage.textContent = sendFailed
    ? "写真を送信できませんでした。通信状態を確認して再送してください。"
    : "写真の送信が完了しました。このページを閉じてください。";
  retryEndSendBtn.hidden = !sendFailed;
}

async function handleSessionEnded() {
  if (sessionEndRequested) return;
  sessionEndRequested = true;
  pendingPostSendResolve?.("finish");
  stopLiveShare();
  shareLiveBtn.textContent = "ライブ共有";
  currentStream?.getTracks().forEach((track) => track.stop());
  captureBtn.disabled = true;
  shareLiveBtn.disabled = true;
  endCaptureBtn.disabled = true;
  endCaptureBtn.textContent = "写真を送信中…";
  sendBtn.disabled = true;
  showSupportMessage("セッションが終了しました。未送信写真を送信しています。", { autoHideMs: 0 });

  let sent = activePhotoSendPromise ? await activePhotoSendPromise : photos.length === 0;
  if (!sent && photos.length > 0) {
    sent = await sendCapturedPhotos({ promptAfterSend: false });
  } else if (photos.length > 0) {
    sent = await sendCapturedPhotos({ promptAfterSend: false });
  }
  showThankYouPage(!sent);
}

retryEndSendBtn.addEventListener("click", async () => {
  retryEndSendBtn.hidden = true;
  sessionEndMessage.textContent = "写真を再送しています。しばらくお待ちください。";
  const sent = await sendCapturedPhotos({ promptAfterSend: false });
  showThankYouPage(!sent);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && shareActive) {
    connectVideoSocket();
  }
});

sendBtn.addEventListener("click", () => {
  void sendCapturedPhotos();
});

window.addEventListener("beforeunload", () => {
  stopLiveShare();
  disconnectVideoSocket();
  disconnectSessionSocket();
  currentStream?.getTracks().forEach((track) => track.stop());
});

function dataURLtoBlob(dataURL) {
  const arr = dataURL.split(",");
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

updatePhotoCount();
showCaptureView();
loadSessionFromUrl();
startCamera();
