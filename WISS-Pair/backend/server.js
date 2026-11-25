const envPath = require("node:path").join(__dirname, ".env");
try { process.loadEnvFile(envPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
const { compareGuidance } = require("./guidance_progress");
const PROTOCOL = "progressive-v1";
const express = require("express");
const multer = require("multer");
const path = require("path");
const guidanceConfigPath = process.env.GUIDANCE_CONFIG || path.join(__dirname, "guide_processor", "guidance_config.json");
const fs = require("fs");
const { createServer } = require("http");
const { execFileSync } = require("child_process");
const { randomUUID } = require("crypto");
const { WebSocket, WebSocketServer } = require("ws");

const app = express();
const port = process.env.PORT || 3101;
const host = process.env.HOST || "127.0.0.1";
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 6);
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_MS || 1000 * 60 * 10);
const uploadFileSizeLimit = Number(process.env.UPLOAD_FILE_SIZE_LIMIT || 20 * 1024 * 1024);

// backend/uploads に保存する
const dataRoot = process.env.WISS_DATA_DIR || path.join(__dirname, "data", "pair");
const uploadRoot = path.join(dataRoot, "uploads");
const referenceGuideRoot = path.join(dataRoot, "reference_guides");
const dataDirectories = {
  photos: "photos",
  drafts: "drafts",
  references: "references",
  guides: "guides",
};
// ../photographer の index.html / script.js / style.css / guide.png を配信する
const photographerDir = path.join(__dirname, "..", "photographer");

fs.mkdirSync(uploadRoot, { recursive: true });
fs.mkdirSync(referenceGuideRoot, { recursive: true });

function safeSessionId(value, fallback = "default") {
  const id = String(value || fallback).trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (id === "." || id === "..") throw Object.assign(new Error("invalid session ID"), { statusCode: 400 });
  return id;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const sessionId = safeSessionId(req.body.sessionId || req.params?.sessionId);
    const dataType =
      file.fieldname === "guide"
        ? "guides"
        : file.fieldname === "reference"
          ? "references"
          : file.fieldname === "draft"
            ? "drafts"
            : "photos";
    const destinationDir = getDataDir(sessionId, dataType);
    fs.mkdirSync(destinationDir, { recursive: true });
    cb(null, destinationDir);
  },

  filename(req, file, cb) {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

    const isGuide = file.fieldname === "guide";
    const isReference = file.fieldname === "reference";
    const isDraft = file.fieldname === "draft";
    const draftClientId = isDraft ? safeIdentifier(req.body.clientId) : "";
    if (draftClientId) {
      cb(null, `draft_${draftClientId}.jpg`);
      return;
    }

    const namePrefix = isGuide
      ? "guide_"
      : isReference
        ? "reference_"
        : isDraft
          ? "draft_"
          : "";

    const uniqueSuffix = Math.random().toString(36).slice(2, 8);
    cb(null, `${namePrefix}${timestamp}_${uniqueSuffix}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: uploadFileSizeLimit,
    files: 50,
  },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image uploads are allowed"));
      return;
    }
    cb(null, true);
  },
});

// 画像URLは絶対URLではなく相対URLで返す
// Cloudflare Tunnel / HTTPS 経由でも mixed content を避けやすくするため
function makeFileUrl(sessionId, filename, dataType = null) {
  const encodedParts = [
    encodeURIComponent(sessionId),
    dataType ? encodeURIComponent(dataDirectories[dataType]) : null,
    encodeURIComponent(filename),
  ].filter(Boolean);
  return `/uploads/${encodedParts.join("/")}`;
}

function makeSessionRelativeFileUrl(sessionId, relativePath) {
  const encodedPath = String(relativePath)
    .split(path.sep)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `/uploads/${encodeURIComponent(sessionId)}/${encodedPath}`;
}

function getSessionDir(sessionId) {
  return path.join(uploadRoot, safeSessionId(sessionId));
}

function getDataDir(sessionId, dataType) {
  const directoryName = dataDirectories[dataType];
  if (!directoryName) {
    throw new Error(`Unknown data type: ${dataType}`);
  }
  return path.join(getSessionDir(sessionId), directoryName);
}

function getGuideFeaturesDir(sessionId) {
  return path.join(getDataDir(sessionId, "guides"), "features");
}

function getGuideFeaturesPath(sessionId, guideId) {
  return path.join(getGuideFeaturesDir(sessionId), `${safeIdentifier(guideId)}.json`);
}

function getCanonicalGuideFeaturesPath(guideId) {
  return path.join(referenceGuideRoot, `${safeIdentifier(guideId)}.json`);
}

function getSessionGuideStatePath(sessionId) {
  return path.join(getSessionDir(sessionId), "current-guide.json");
}

function getSessionLifecyclePath(sessionId) {
  return path.join(getSessionDir(sessionId), "session-lifecycle.json");
}

function getAnalysisDir(sessionId) {
  return path.join(getSessionDir(sessionId), "analysis");
}

function getObservationPath(sessionId, photoId) {
  return path.join(getAnalysisDir(sessionId), "observations", `${safeIdentifier(photoId)}.json`);
}

function getRoleGuidancePath(sessionId, photoId) {
  return path.join(getAnalysisDir(sessionId), "role_guidance", `${safeIdentifier(photoId)}.json`);
}

function safeIdentifier(value, fallback = "") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function requiredString(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    const error = new Error(`${fieldName} is required`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      return {
        filename: entry.name,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    });
}

function listLegacyFiles(sessionId, predicate) {
  const sessionDir = getSessionDir(sessionId);
  if (!fs.existsSync(sessionDir)) return [];
  return fs
    .readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && predicate(entry.name))
    .map((entry) => {
      const filePath = path.join(sessionDir, entry.name);
      return {
        filename: entry.name,
        mtimeMs: fs.statSync(filePath).mtimeMs,
        legacy: true,
      };
    });
}

function runPythonGuideGenerator(inputPath, outputPath, guideType, cropParams = null) {
  const scriptPath = path.join(__dirname, "guide_processor", "generate_guide.py");
  const pythonCommand = process.env.WISS_PYTHON || process.env.PYTHON || "python3";

  const args = [scriptPath, "--input", inputPath, "--output", outputPath, "--type", guideType];

  if (cropParams && cropParams.cropX !== undefined && cropParams.cropY !== undefined &&
      cropParams.cropWidth !== undefined && cropParams.cropHeight !== undefined) {
    args.push("--crop-x", String(cropParams.cropX));
    args.push("--crop-y", String(cropParams.cropY));
    args.push("--crop-width", String(cropParams.cropWidth));
    args.push("--crop-height", String(cropParams.cropHeight));
  }

  try {
    execFileSync(pythonCommand, args, {
      stdio: ["ignore", "pipe", "pipe"], cwd: __dirname, timeout: 120000,
    });
  } catch (error) {
    const stderr = String(error.stderr || "");
    const userError = stderr.match(/GUIDE_USER_ERROR:([^\r\n]+)/);
    if (userError) {
      const guideError = new Error(userError[1].trim());
      guideError.statusCode = 422;
      throw guideError;
    }
    throw error;
  }
}

function sendGuideGenerationError(res, error, fallbackMessage) {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: error.statusCode ? error.message : fallbackMessage,
  });
}

function runReferenceFeaturesExtractor(inputPath, outputPath, guideId, referencePhotoId, cropParams = null) {
  const scriptPath = path.join(
    __dirname,
    "guide_processor",
    "extract_reference_features.py"
  );
  const pythonCommand = process.env.WISS_PYTHON || process.env.PYTHON || "python3";
  const args = [
    scriptPath,
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--guide-id",
    guideId,
    "--reference-photo-id",
    referencePhotoId,
  ];
  if (cropParams) {
    args.push("--crop-x", String(cropParams.cropX));
    args.push("--crop-y", String(cropParams.cropY));
    args.push("--crop-width", String(cropParams.cropWidth));
    args.push("--crop-height", String(cropParams.cropHeight));
  }
  execFileSync(pythonCommand, args, {
    stdio: ["ignore", "pipe", "pipe"], cwd: __dirname, timeout: 120000,
  });
}

function runLiveFeaturesExtractor(inputPath, outputPath, sessionId, source = "capturedPhoto") {
  const scriptPath = path.join(
    __dirname,
    "guide_processor",
    "extract_live_features.py"
  );
  const pythonCommand = process.env.WISS_PYTHON || process.env.PYTHON || "python3";
  const args = [
    scriptPath,
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--session-id",
    sessionId,
    "--source",
    source,
  ];

  execFileSync(pythonCommand, args, {
    stdio: ["ignore", "pipe", "pipe"], cwd: __dirname, timeout: 120000,
  });
}

function runRoleGuidance(referencePath, observationPath, outputPath, guideTransform = {}, condition = "B", configPath = guidanceConfigPath) {
  const scriptPath = path.join(__dirname, "guide_processor", "role_guidance.py");
  const pythonCommand = process.env.WISS_PYTHON || process.env.PYTHON || "python3";
  execFileSync(
    pythonCommand,
    [
      scriptPath,
      "--reference",
      referencePath,
      "--observation",
      observationPath,
      "--output",
      outputPath,
      "--guide-transform",
      JSON.stringify(guideTransform || {}),
      "--condition", condition,
      "--config", configPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"], cwd: __dirname, timeout: 120000 }
  );
}

function parseCropParams(body) {
  const cropParams = {};
  if (body.cropX !== undefined) cropParams.cropX = parseFloat(body.cropX);
  if (body.cropY !== undefined) cropParams.cropY = parseFloat(body.cropY);
  if (body.cropWidth !== undefined) cropParams.cropWidth = parseFloat(body.cropWidth);
  if (body.cropHeight !== undefined) cropParams.cropHeight = parseFloat(body.cropHeight);

  const hasCropParams =
    cropParams.cropX !== undefined &&
    cropParams.cropY !== undefined &&
    cropParams.cropWidth !== undefined &&
    cropParams.cropHeight !== undefined;

  return hasCropParams ? cropParams : null;
}

function parseGuideTransform(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object") return {};
  return value;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseOptionalInteger(value) {
  const number = parseOptionalNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0
    ? number
    : null;
}

function parseTimestamp(value) {
  const numeric = parseOptionalNumber(value);
  if (numeric !== null) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function analysisEventPayload(context, extra = {}) {
  return {
    analysisId: context.analysisId,
    sessionId: context.sessionId,
    photoId: context.photoId || null,
    clientId: context.clientId || null,
    captureSequence: context.captureSequence,
    captureTimestamp: context.captureTimestamp,
    analysisStartTimestamp: context.analysisStartTimestamp,
    guideId: context.guideId || null,
    ...extra,
  };
}

function findPhotoPath(sessionId, photoId) {
  const safePhotoId = safeIdentifier(photoId);
  const candidates = [
    path.join(getDataDir(sessionId, "photos"), safePhotoId),
    path.join(getDataDir(sessionId, "drafts"), safePhotoId),
    path.join(getSessionDir(sessionId), safePhotoId),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function latestGuideFeaturesPath(sessionId) {
  const featureFiles = listFiles(getGuideFeaturesDir(sessionId))
    .filter((file) => file.filename.endsWith(".json"))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (featureFiles.length === 0) return null;
  return path.join(getGuideFeaturesDir(sessionId), featureFiles[0].filename);
}

function findGuideFeaturesAcrossSessions(guideId) {
  if (!guideId || !fs.existsSync(uploadRoot)) return null;
  for (const entry of fs.readdirSync(uploadRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = getGuideFeaturesPath(entry.name, guideId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findGuideFeaturesPath(sessionId, guideId) {
  if (guideId) {
    if (sessionId) {
      const exactPath = getGuideFeaturesPath(sessionId, guideId);
      if (fs.existsSync(exactPath)) return exactPath;
    }
    const canonicalPath = getCanonicalGuideFeaturesPath(guideId);
    if (fs.existsSync(canonicalPath)) return canonicalPath;
    return findGuideFeaturesAcrossSessions(guideId);
  }
  return sessionId ? latestGuideFeaturesPath(sessionId) : null;
}

function publicFeatureFile(sessionId, guideId) {
  const filePath = findGuideFeaturesPath(sessionId, guideId);
  if (!filePath) return null;
  return readJsonFile(filePath);
}

function persistCanonicalGuideFeatures(featuresPath, guideId) {
  const features = readJsonFile(featuresPath);
  if (!features) return false;
  writeJsonFile(getCanonicalGuideFeaturesPath(guideId), features);
  const photoPath = featuresPath.replace(/\.json$/, ".jpg");
  if (fs.existsSync(photoPath)) {
    fs.copyFileSync(photoPath, getCanonicalGuideFeaturesPath(guideId).replace(/\.json$/, ".jpg"));
  }
  return true;
}

function featuresPathFromUrl(featuresUrl, guideId) {
  if (!featuresUrl || !guideId) return null;
  try {
    const url = new URL(featuresUrl, "http://local");
    const expectedPath = `/api/guides/${encodeURIComponent(guideId)}/features`;
    if (url.pathname !== expectedPath) return null;
    const sourceSessionId = safeSessionId(url.searchParams.get("sessionId"), "");
    if (!sourceSessionId) return null;
    const sourcePath = getGuideFeaturesPath(sourceSessionId, guideId);
    return fs.existsSync(sourcePath) ? sourcePath : null;
  } catch {
    return null;
  }
}

function copyGuideFeaturesToSession(sessionId, guideId, featuresUrl) {
  if (!sessionId || !guideId) return false;
  const targetPath = getGuideFeaturesPath(sessionId, guideId);
  if (fs.existsSync(targetPath)) return true;
  const sourcePath =
    featuresPathFromUrl(featuresUrl, guideId) ||
    findGuideFeaturesPath("", guideId);
  const features = sourcePath ? readJsonFile(sourcePath) : null;
  if (!features) return false;
  writeJsonFile(targetPath, features);
  writeJsonFile(getCanonicalGuideFeaturesPath(guideId), features);
  return true;
}

app.use(express.json());
app.use("/uploads", (req, res, next) => {
  const parts = req.path.split("/").filter(Boolean);
  if (parts.length !== 3 || !Object.values(dataDirectories).includes(parts[1]) || !/\.(png|jpe?g|webp)$/i.test(parts[2])) return res.sendStatus(404);
  next();
}, express.static(uploadRoot));

// photographer の静的ファイルを配信
app.use(express.static(photographerDir));

// QRで /?sessionId=... にアクセスされたとき index.html を返す
app.get("/", (req, res) => {
  res.sendFile(path.join(photographerDir, "index.html"));
});

const server = createServer(app);

// sessionId ごとに sender / receiver を管理
const sessions = new Map();

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      senders: new Set(),
      receivers: new Set(),
      watchers: new Set(),
    });
  }

  return sessions.get(sessionId);
}

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.senders.size === 0 && session.receivers.size === 0 && session.watchers.size === 0) {
    sessions.delete(sessionId);
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function notifySession(sessionId, payload) {
  const session = sessions.get(sessionId);
  if (!session) return;

  for (const watcher of session.watchers) {
    sendJson(watcher, payload);
  }
}

function removeSessionFiles(sessionId) {
  const sessionDir = getSessionDir(sessionId);
  if (!fs.existsSync(sessionDir)) return false;

  fs.rmSync(sessionDir, { recursive: true, force: true });
  return true;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  if (!fs.existsSync(uploadRoot)) return;

  for (const entry of fs.readdirSync(uploadRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const sessionDir = path.join(uploadRoot, entry.name);
    let stat;
    try {
      stat = fs.statSync(sessionDir);
    } catch {
      continue;
    }

    if (now - stat.mtimeMs > sessionTtlMs) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      notifySession(entry.name, {
        type: "session-deleted",
        sessionId: entry.name,
        reason: "expired",
      });
      console.log(`expired session deleted: ${entry.name}`);
    }
  }
}

// WebSocket: 撮影者Web → 被写体iOS に映像フレームを送る
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

const sessionWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

// A single HTTP server must route each upgrade request to exactly one
// WebSocketServer. Attaching multiple WebSocketServer instances directly to
// the same server makes the non-matching instance reject an already accepted
// connection.
server.on("upgrade", (req, socket, head) => {
  let pathname;

  try {
    pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    socket.destroy();
    return;
  }

  const targetServer =
    pathname === "/ws/video"
      ? wss
      : pathname === "/ws/session"
        ? sessionWss
        : null;

  if (!targetServer) {
    socket.destroy();
    return;
  }

  targetServer.handleUpgrade(req, socket, head, (ws) => {
    targetServer.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const sessionId = safeSessionId(url.searchParams.get("sessionId"), "");
  const role = url.searchParams.get("role");

  if (!sessionId || !["sender", "receiver"].includes(role)) {
    ws.close(1008, "sessionId and role are required");
    return;
  }

  const session = getOrCreateSession(sessionId);

  if (role === "sender") {
    session.senders.add(ws);
    console.log(`sender connected: ${sessionId}`);
  } else {
    session.receivers.add(ws);
    console.log(`receiver connected: ${sessionId}`);
  }

  ws.on("message", (message) => {
    if (role === "receiver") {
      try {
        const payload = JSON.parse(message.toString());
        if (payload.type === "guide-transform") {
          notifySession(sessionId, {
            type: "guide-transform",
            sessionId,
            transform: {
              offsetX: Number(payload.offsetX) || 0,
              offsetY: Number(payload.offsetY) || 0,
              scale: Number(payload.scale) || 1,
              opacity: Number(payload.opacity) || 0.5,
            },
          });
        }
      } catch {
        // receiver normally does not send video frames; ignore non-JSON messages.
      }
      return;
    }

    // sender から来た画像フレームを receiver 全員に送る
    for (const receiver of session.receivers) {
      if (receiver.readyState === WebSocket.OPEN) {
        receiver.send(message);
      }
    }
  });

  ws.on("close", () => {
    if (role === "sender") {
      session.senders.delete(ws);
      console.log(`sender disconnected: ${sessionId}`);
    } else {
      session.receivers.delete(ws);
      console.log(`receiver disconnected: ${sessionId}`);
    }

    cleanupSession(sessionId);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// WebSocket: ガイド更新やセッション削除を撮影者Webへ通知する
sessionWss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = safeSessionId(url.searchParams.get("sessionId"), "");

  if (!sessionId) {
    ws.close(1008, "sessionId is required");
    return;
  }

  const session = getOrCreateSession(sessionId);
  session.watchers.add(ws);
  sendJson(ws, {
    type: "connected",
    sessionId,
  });
  const lifecycle = readJsonFile(getSessionLifecyclePath(sessionId));
  if (lifecycle?.status === "ended") {
    sendJson(ws, {
      type: "session-ended",
      sessionId,
      endedAt: lifecycle.endedAt,
    });
  }

  ws.on("close", () => {
    session.watchers.delete(ws);
    cleanupSession(sessionId);
  });

  ws.on("error", (error) => {
    console.error("session WebSocket error:", error);
  });
});

// 撮影直後解析用の下書き写真。iOSへはまだ共有しない。
app.post(
  "/api/sessions/:sessionId/draft-photos",
  upload.single("draft"),
  (req, res, next) => {
    try {
      const sessionId = safeSessionId(req.params.sessionId, "");
      if (!sessionId || !req.file) {
        return res.status(400).json({
          success: false,
          error: "sessionId and draft photo are required",
        });
      }

      const photoId = req.file.filename;
      const clientId = safeIdentifier(req.body.clientId);
      const captureSequence = parseOptionalInteger(req.body.captureSequence);
      const captureTimestamp = parseTimestamp(req.body.captureTimestamp);
      const guideId = safeIdentifier(req.body.guideId);
      const guideTransform = parseGuideTransform(req.body.guideTransform);


      res.json({
        success: true,
        sessionId,
        photo: {
          photoId,
          filename: photoId,
          status: "draft",
          clientId: clientId || null,
          captureSequence,
          captureTimestamp,
          guideId: guideId || null,
          guideTransform,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

app.delete("/api/sessions/:sessionId/draft-photos/:photoId", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId, "");
    const photoId = safeIdentifier(req.params.photoId);
    if (!sessionId || !photoId) {
      return res.status(400).json({ success: false, error: "sessionId and photoId are required" });
    }

    const draftPath = path.join(getDataDir(sessionId, "drafts"), photoId);
    const deleted = fs.existsSync(draftPath);
    if (deleted) fs.unlinkSync(draftPath);
    res.json({ success: true, sessionId, photoId, deleted });
  } catch (error) {
    next(error);
  }
});

// 選択中の下書きだけを正式写真へ昇格し、この時点で初めてiOSへ通知する。
app.post("/api/sessions/:sessionId/photos/share", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId, "");
    const sourcePhotoIds = Array.isArray(req.body.photoIds) ? req.body.photoIds : [];
    const photoIds = [...new Set(sourcePhotoIds.map((value) => safeIdentifier(value)).filter(Boolean))];
    if (!sessionId || photoIds.length === 0) {
      return res.status(400).json({ success: false, error: "sessionId and photoIds are required" });
    }
    if (photoIds.length > 50) {
      return res.status(400).json({ success: false, error: "a maximum of 50 photos can be shared" });
    }

    const draftDir = getDataDir(sessionId, "drafts");
    const photoDir = getDataDir(sessionId, "photos");
    fs.mkdirSync(photoDir, { recursive: true });
    const paths = photoIds.map((photoId) => ({
      photoId,
      draftPath: path.join(draftDir, photoId),
      photoPath: path.join(photoDir, photoId),
    }));
    const missingPhotoIds = paths
      .filter(({ draftPath, photoPath }) => !fs.existsSync(draftPath) && !fs.existsSync(photoPath))
      .map(({ photoId }) => photoId);
    if (missingPhotoIds.length > 0) {
      return res.status(404).json({
        success: false,
        error: "draft photos not found",
        missingPhotoIds,
      });
    }

    for (const { draftPath, photoPath } of paths) {
      if (fs.existsSync(draftPath) && !fs.existsSync(photoPath)) {
        fs.renameSync(draftPath, photoPath);
      }
    }

    const files = photoIds.map((filename) => ({
      filename,
      url: makeFileUrl(sessionId, filename, "photos"),
    }));


    res.json({ success: true, sessionId, files });
    notifySession(sessionId, { type: "photos-updated", sessionId, files });
  } catch (error) {
    next(error);
  }
});

// 撮影者Webから写真を送信
app.post("/api/photos", upload.array("photos"), (req, res, next) => {
  const sessionId = safeSessionId(req.body.sessionId);

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      error: "photos are required",
    });
  }

  const files = req.files.map((file) => ({
    filename: file.filename,
    url: makeFileUrl(sessionId, file.filename, "photos"),
  }));

  res.json({
    success: true,
    sessionId,
    files,
  });

  notifySession(sessionId, {
    type: "photos-updated",
    sessionId,
    files,
  });


});

// iOS側などからガイド画像をアップロード
app.post("/api/session/:sessionId/guide", upload.single("guide"), (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId, "");

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "guide file is required",
    });
  }

  const url = makeFileUrl(sessionId, req.file.filename, "guides");
  const guideId = safeIdentifier(req.body.guideId);
  const sourceFeaturesUrl = String(req.body.featuresUrl || "").trim() || null;
  const featuresAvailable = guideId
    ? copyGuideFeaturesToSession(sessionId, guideId, sourceFeaturesUrl)
    : false;
  const featuresUrl = guideId
    ? `/api/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`
    : null;

  const payload = {
    success: true,
    sessionId,
    guide: {
      guideId: guideId || null,
      filename: req.file.filename,
      url,
      featuresUrl,
      featuresAvailable,
    },
  };

  writeJsonFile(getSessionGuideStatePath(sessionId), payload.guide);

  res.json(payload);
  notifySession(sessionId, {
    type: "guide-updated",
    sessionId,
    guide: payload.guide,
  });
});

app.post("/api/session/:sessionId/generate-guide", upload.single("reference"), (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);
  const guideType = ((req.body.guideType || "rectangle") || "rectangle").trim();

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "reference image is required",
    });
  }

  const cropParams = parseCropParams(req.body);

  const allowedTypes = new Set(["rectangle", "keypoints", "silhouette"]);
  const safeGuideType = allowedTypes.has(guideType) ? guideType : "rectangle";
  const guideId = `guide_${safeGuideType}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const outputFilename = `${guideId}.png`;
  const guideDir = getDataDir(sessionId, "guides");
  fs.mkdirSync(guideDir, { recursive: true });
  const outputPath = path.join(guideDir, outputFilename);
  const featuresPath = getGuideFeaturesPath(sessionId, guideId);

  try {
    if (cropParams) {
      runPythonGuideGenerator(req.file.path, outputPath, safeGuideType, cropParams);
    } else {
      runPythonGuideGenerator(req.file.path, outputPath, safeGuideType);
    }
    runReferenceFeaturesExtractor(
      req.file.path,
      featuresPath,
      guideId,
      req.file.filename,
      cropParams
    );
    persistCanonicalGuideFeatures(featuresPath, guideId);
  } catch (error) {
    console.error("guide generation failed:", error);
    return sendGuideGenerationError(res, error, "guide generation failed");
  }

  const url = makeFileUrl(sessionId, outputFilename, "guides");

  const payload = {
    success: true,
    sessionId,
    guide: {
      guideId,
      filename: outputFilename,
      url,
      featuresUrl: `/api/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`,
      featuresAvailable: true,
    },
  };

  res.json(payload);
  notifySession(sessionId, {
    type: "guide-updated",
    sessionId,
    guide: payload.guide,
  });
});

app.post("/api/session/:sessionId/generate-guide-set", upload.single("reference"), (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "reference image is required",
    });
  }

  const cropParams = parseCropParams(req.body);
  const guideTypes = ["rectangle", "keypoints", "silhouette"];
  const batchId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  const guideId = `guide_set_${batchId}`;
  const guides = {};
  const guideDir = getDataDir(sessionId, "guides");
  fs.mkdirSync(guideDir, { recursive: true });
  const featuresPath = getGuideFeaturesPath(sessionId, guideId);

  try {
    for (const guideType of guideTypes) {
      const outputFilename = `guide_${guideType}_${batchId}.png`;
      const outputPath = path.join(guideDir, outputFilename);

      if (cropParams) {
        runPythonGuideGenerator(req.file.path, outputPath, guideType, cropParams);
      } else {
        runPythonGuideGenerator(req.file.path, outputPath, guideType);
      }

      guides[guideType] = {
        guideId,
        filename: outputFilename,
        url: makeFileUrl(sessionId, outputFilename, "guides"),
        featuresUrl: `/api/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`,
      };
    }
    runReferenceFeaturesExtractor(
      req.file.path,
      featuresPath,
      guideId,
      req.file.filename,
      cropParams
    );
    persistCanonicalGuideFeatures(featuresPath, guideId);
  } catch (error) {
    console.error("guide set generation failed:", error);
    return sendGuideGenerationError(res, error, "guide set generation failed");
  }

  res.json({
    success: true,
    sessionId,
    referenceGuide: {
      guideId,
      featuresUrl: `/api/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`,
    },
    guides,
  });
});

// 撮影者Webがセッションの最新ガイド画像を取得
app.get("/api/session/:sessionId/guide", (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "sessionId is required",
    });
  }

  const guideFiles = [
    ...listFiles(getDataDir(sessionId, "guides")),
    ...listLegacyFiles(sessionId, (filename) => filename.startsWith("guide_")),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const guideFile = guideFiles[0];

  if (!guideFile) {
    return res.json({
      success: true,
      guide: null,
    });
  }

  const url = makeFileUrl(
    sessionId,
    guideFile.filename,
    guideFile.legacy ? null : "guides"
  );

  const storedGuide = readJsonFile(getSessionGuideStatePath(sessionId));

  res.json({
    success: true,
    guide: {
      guideId: storedGuide?.guideId || null,
      filename: guideFile.filename,
      url,
      featuresUrl: storedGuide?.featuresUrl || null,
      featuresAvailable: storedGuide?.featuresAvailable === true,
    },
  });
});

// セッションごとの保存済み写真一覧
app.get("/api/photos", (req, res) => {
  const sessionId = safeSessionId(req.query.sessionId, "");

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "sessionId is required",
    });
  }

  const files = [
    ...listFiles(getDataDir(sessionId, "photos")).map((file) => ({
      ...file,
      url: makeFileUrl(sessionId, file.filename, "photos"),
    })),
    ...listLegacyFiles(
      sessionId,
      (filename) =>
        filename !== "current-guide.json" &&
        filename !== "session-lifecycle.json" &&
        !filename.startsWith("guide_") &&
        !filename.startsWith("reference_")
    ).map((file) => ({
      ...file,
      url: makeFileUrl(sessionId, file.filename),
    })),
  ]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ filename, url }) => ({ filename, url }));

  res.json({
    success: true,
    files,
  });
});

// Serve the exact crop used for guide generation, independently of the active session.
app.get("/api/guides/:guideId/reference", (req, res) => {
  const guideId = safeIdentifier(req.params.guideId);
  const sessionId = safeSessionId(req.query.sessionId, "");
  const featuresPath = findGuideFeaturesPath(sessionId, guideId);
  if (!featuresPath) return res.status(404).json({ error: "reference photo not found" });
  const photoPath = getCanonicalGuideFeaturesPath(guideId).replace(/\.json$/, ".jpg");
  try {
    if (!fs.existsSync(photoPath)) {
      const localPhoto = featuresPath.replace(/\.json$/, ".jpg");
      if (fs.existsSync(localPhoto)) {
        fs.copyFileSync(localPhoto, photoPath);
      } else {
        // Older guides have crop metadata but no pre-rendered reference photo.
        const features = readJsonFile(featuresPath);
        const filename = features?.referencePhotoId;
        if (!filename || path.basename(filename) !== filename) {
          return res.status(404).json({ error: "reference photo not available" });
        }
        const source = fs.readdirSync(uploadRoot, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => path.join(uploadRoot, entry.name, "references", filename))
          .find(candidate => fs.existsSync(candidate));
        if (!source) return res.status(404).json({ error: "reference photo not available" });
        execFileSync(process.env.WISS_PYTHON || process.env.PYTHON || "python3", [
          path.join(__dirname, "guide_processor", "render_reference_photo.py"),
          source, photoPath, JSON.stringify(features.cropRect || null),
        ], { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      }
    }
    return res.sendFile(photoPath);
  } catch (error) {
    console.error("reference photo rendering failed:", error);
    return res.status(500).json({ error: "reference photo rendering failed" });
  }
});

app.get("/api/guides/:guideId/features", (req, res) => {
  const guideId = safeIdentifier(req.params.guideId);
  const sessionId = safeSessionId(req.query.sessionId, "");

  if (!guideId) {
    return res.status(400).json({
      success: false,
      error: "guideId is required",
    });
  }
  const referenceGuide = publicFeatureFile(sessionId, guideId);
  if (!referenceGuide) {
    return res.status(404).json({
      success: false,
      error: "guide features not found",
    });
  }

  res.json({
    success: true,
    sessionId,
    guideId,
    referenceGuide,
  });
});

function analyzeCapturedPhoto(req, res, next) {
  const context = {
    analysisId: `analysis_${randomUUID()}`,
    sessionId: safeSessionId(req.params.sessionId, ""),
    photoId: safeIdentifier(req.params.photoId),
    clientId: safeIdentifier(req.body.clientId),
    captureSequence: parseOptionalInteger(req.body.captureSequence),
    captureTimestamp: parseTimestamp(req.body.captureTimestamp),
    analysisStartTimestamp: Date.now(),
    guideId: safeIdentifier(req.body.guideId),
  };
  const guideTransform = parseGuideTransform(req.body.guideTransform);

  notifySession(context.sessionId, {
    type: "analysisStarted",
    ...analysisEventPayload(context),
    guideTransform,
    analysisStatus: "started",
  });


  try {
    const { sessionId, photoId, guideId } = context;

    if (!sessionId || !photoId) {
      const error = new Error("sessionId and photoId are required");
      error.statusCode = 400;
      throw error;
    }

    const photoPath = findPhotoPath(sessionId, photoId);
    if (!photoPath) {
      const error = new Error("photo not found");
      error.statusCode = 404;
      throw error;
    }


    const referencePath = findGuideFeaturesPath(sessionId, guideId);
    if (!referencePath) {
      const error = new Error("reference guide features not found");
      error.statusCode = 404;
      throw error;
    }

    const observationPath = getObservationPath(sessionId, photoId);
    const guidancePath = getRoleGuidancePath(sessionId, photoId);
    runLiveFeaturesExtractor(photoPath, observationPath, sessionId, "capturedPhoto");
    const appliedTransform = guideTransform;
    const configPath = guidanceConfigPath;
    runRoleGuidance(referencePath, observationPath, guidancePath, appliedTransform, "B", configPath);

    const referenceGuide = readJsonFile(referencePath);
    const liveObservation = readJsonFile(observationPath);
    const roleGuidance = readJsonFile(guidancePath);
    const analysisEndTimestamp = Date.now();
    const payload = {
      success: true,
      ...analysisEventPayload(context, {
        analysisEndTimestamp,
        guideId: referenceGuide?.guideId || guideId || null,
      }),
      ...roleGuidance,
      guidanceProtocolVersion: PROTOCOL,
      referencePoseVersion: null,
      guideTransform: appliedTransform,
      referenceGuide,
      liveObservation,
      alignmentError: roleGuidance.alignmentError,
      photographerGuidance: roleGuidance.photographerGuidance || [],
      subjectGuidance: roleGuidance.subjectGuidance || [],
      ready: roleGuidance.ready || {},
      analysisStatus: "completed",
      errorReason: null,
    };
    const statePath = path.join(getAnalysisDir(sessionId), `progress_${safeIdentifier(guideId)}.json`);
    const previous = readJsonFile(statePath);
    payload.guidanceProgress = compareGuidance(previous, payload);
    payload.isLatestAnalysis = !previous || (Number.isSafeInteger(payload.captureSequence) && payload.captureSequence > previous.captureSequence);
    writeJsonFile(guidancePath, payload);
    if (payload.isLatestAnalysis) writeJsonFile(statePath, payload);



    if (payload.isLatestAnalysis) {
      notifySession(sessionId, {
        type: "alignmentResult",
        ...analysisEventPayload(context, { analysisEndTimestamp }),
        alignmentError: roleGuidance.alignmentError,
      });
      notifySession(sessionId, {
        type: "roleGuidanceUpdated",
        ...payload,
        referenceGuide: undefined,
        liveObservation: undefined,
      });
      notifySession(sessionId, {
        type: "readyStateUpdated",
        ...analysisEventPayload(context, { analysisEndTimestamp }),
        ready: roleGuidance.ready,
      });

    }
    res.json(payload);
  } catch (error) {
    console.error("photo analysis failed:", error);
    const analysisEndTimestamp = Date.now();
    const failedPayload = analysisEventPayload(context, {
      analysisEndTimestamp,
      guideTransform,
      alignmentError: null,
      photographerGuidance: [],
      subjectGuidance: [],
      ready: {},
      analysisStatus: "failed",
      errorReason: error.message || "analysis failed",
    });
    notifySession(context.sessionId, {
      type: "analysisFailed",
      ...failedPayload,
    });

    error.analysisId = context.analysisId;
    next(error);
  }
}
app.post("/api/sessions/:sessionId/photos/:photoId/analyze", analyzeCapturedPhoto);

app.post("/api/sessions/:sessionId/analyze-frame", upload.single("frame"), (req, res, next) => {
  let context = null;
  try {
    const sessionId = safeSessionId(req.params.sessionId, "");
    const guideId = safeIdentifier(req.body.guideId);
    const guideTransform = parseGuideTransform(req.body.guideTransform);

    if (!sessionId || !req.file) {
      return res.status(400).json({
        success: false,
        error: "sessionId and frame are required",
      });
    }

    const referencePath = findGuideFeaturesPath(sessionId, guideId);
    if (!referencePath) {
      return res.status(404).json({
        success: false,
        error: "reference guide features not found",
      });
    }

    const frameId = path.parse(req.file.filename).name;
    context = {
      analysisId: `analysis_${randomUUID()}`,
      sessionId,
      photoId: frameId,
      clientId: safeIdentifier(req.body.clientId),
      captureSequence: parseOptionalInteger(req.body.captureSequence),
      captureTimestamp: parseTimestamp(req.body.captureTimestamp),
      analysisStartTimestamp: Date.now(),
      guideId,
    };
    notifySession(sessionId, {
      type: "analysisStarted",
      ...analysisEventPayload(context),
      analysisStatus: "started",
    });
    const observationPath = getObservationPath(sessionId, frameId);
    const guidancePath = getRoleGuidancePath(sessionId, frameId);
    runLiveFeaturesExtractor(req.file.path, observationPath, sessionId, "liveFrame");
    runRoleGuidance(referencePath, observationPath, guidancePath, guideTransform);

    const roleGuidance = readJsonFile(guidancePath);
    const analysisEndTimestamp = Date.now();
    const payload = {
      success: true,
      ...analysisEventPayload(context, {
        analysisEndTimestamp,
        guideId: guideId || readJsonFile(referencePath)?.guideId || null,
      }),
      frameId,
      guideTransform,
      liveObservation: readJsonFile(observationPath),
      alignmentError: roleGuidance.alignmentError,
      photographerGuidance: roleGuidance.photographerGuidance || [],
      subjectGuidance: roleGuidance.subjectGuidance || [],
      ready: roleGuidance.ready || {},
      analysisStatus: "completed",
      errorReason: null,
    };

    notifySession(sessionId, {
      type: "roleGuidanceUpdated",
      ...payload,
      liveObservation: undefined,
    });
    notifySession(sessionId, {
      type: "readyStateUpdated",
      sessionId,
      frameId,
      ready: roleGuidance.ready,
    });

    res.json(payload);
  } catch (error) {
    console.error("frame analysis failed:", error);
    if (context) {
      notifySession(context.sessionId, {
        type: "analysisFailed",
        ...analysisEventPayload(context, {
          analysisEndTimestamp: Date.now(),
          alignmentError: null,
          photographerGuidance: [],
          subjectGuidance: [],
          ready: {},
          analysisStatus: "failed",
          errorReason: error.message || "analysis failed",
        }),
      });
      error.analysisId = context.analysisId;
    }
    next(error);
  }
});

app.delete("/api/session/:sessionId", (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId, "");

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "sessionId is required",
    });
  }

  const deleted = removeSessionFiles(sessionId);
  notifySession(sessionId, {
    type: "session-deleted",
    sessionId,
    reason: "manual",
  });

  res.json({
    success: true,
    sessionId,
    deleted,
  });
});

// iOS側から撮影終了を通知する。写真などの保存データは削除しない。
app.post("/api/session/:sessionId/end", (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId, "");

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "sessionId is required",
    });
  }

  const lifecyclePath = getSessionLifecyclePath(sessionId);
  const existing = readJsonFile(lifecyclePath);
  const lifecycle = existing?.status === "ended"
    ? existing
    : {
        status: "ended",
        endedAt: new Date().toISOString(),
      };

  writeJsonFile(lifecyclePath, lifecycle);
  notifySession(sessionId, {
    type: "session-ended",
    sessionId,
    endedAt: lifecycle.endedAt,
  });

  res.json({
    success: true,
    sessionId,
    ...lifecycle,
  });
});

// 動作確認用
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "server is running",
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof multer.MulterError) {
    const statusCode = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.code,
    });
    return;
  }

  console.error("request failed:", error);
  res.status(error.statusCode || 400).json({
    success: false,
    error: error.message || "request failed",
    analysisId: error.analysisId || null,
  });
});

server.listen(port, host, () => {
  cleanupExpiredSessions();
  setInterval(cleanupExpiredSessions, cleanupIntervalMs).unref();

  console.log(`Photo backend listening on http://${host}:${port} (internal only)`);
  console.log(`Local page: http://${host}:${port}/?sessionId=test`);
  console.log(`Session TTL: ${Math.round(sessionTtlMs / 60000)} minutes`);
  console.log(`Upload file limit: ${Math.round(uploadFileSizeLimit / 1024 / 1024)} MB`);
});
