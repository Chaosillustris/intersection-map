const storageKey = "intersection-map-settings-v1";
const defaultCanvasSize = { width: 1600, height: 1200 };
const canvasSizeLimits = { min: 480, max: 6000 };
const dragGranularity = 0.25;
const imageOptimization = {
  maxDimension: 2048,
  maxFileSizeBytes: 6 * 1024 * 1024,
  jpegQuality: 0.86,
  webpQuality: 0.84,
};
const uploadLimits = {
  // Hard ceiling: anything bigger is almost certainly not a photo the browser can decode on a phone.
  maxFileSizeBytes: 120 * 1024 * 1024,
  // Safety nets so a stuck decode can never freeze the upload queue (seen on iOS under memory pressure).
  imageLoadTimeoutMs: 45000,
  heicDecodeTimeoutMs: 120000,
  decoderScriptTimeoutMs: 60000,
  decoderScriptAttempts: 3,
  fileReadAttempts: 2,
};
const appScriptBaseUrl = document.currentScript?.src || window.location.href;
const heicDecoders = {
  // libheif 1.19+ (heic-to) decodes current iPhone/Android HEIC files; heic2any (libheif 1.8) is a fallback only.
  primary: { global: "HeicTo", path: "vendor/heic-to.iife.js" },
  fallback: { global: "heic2any", path: "vendor/heic2any.min.js" },
};
const heicDecoderPromises = new Map();
let uploadQueue = Promise.resolve();
const toneModes = ["off", "soft", "strong"];

// cols × rows is the classic layout grid; the square display grid keeps cols and derives rows
// from the field proportions (see getGrid and layoutOnClassicGrid).
const gridPresets = [
  { cols: 12, rows: 9 },
  { cols: 14, rows: 10 },
  { cols: 16, rows: 10 },
  { cols: 10, rows: 8 },
];

// Every slider starts in the middle; "reset to middle" returns them here.
// (density is shown as "size": it scales the tiles.)
const defaultControls = { density: 50, overlap: 50, variation: 50, air: 50 };

// Undo/redo steps (see recordHistory) and every image URL created, so unused ones can be revoked.
const historyLimit = 40;
const undoHistory = { undo: [], redo: [], mergeKey: null, mergedAt: 0 };
const knownAssets = new Map();

// Set only while a layout runs on the classic preset grid.
let layoutGridOverride = null;
// Candidate layouts per update/scatter; the one closest to the "air" target wins.
const layoutAttempts = 8;

const elements = {
  workspace: document.getElementById("workspace"),
  dropOverlay: document.getElementById("dropOverlay"),
  loadingOverlay: document.getElementById("loadingOverlay"),
  loadingTitle: document.getElementById("loadingTitle"),
  loadingMeta: document.getElementById("loadingMeta"),
  loadingHint: document.getElementById("loadingHint"),
  loadingBar: document.getElementById("loadingBar"),
  loadingBarDone: document.getElementById("loadingBarDone"),
  loadingBarCurrent: document.getElementById("loadingBarCurrent"),
  loadingThumbs: document.getElementById("loadingThumbs"),
  stopUploadButton: document.getElementById("stopUploadButton"),
  photoCount: document.getElementById("photoCount"),
  anchorLabel: document.getElementById("anchorLabel"),
  gridButton: document.getElementById("gridButton"),
  gridLabel: document.getElementById("gridLabel"),
  toneButton: document.getElementById("toneButton"),
  toneLabel: document.getElementById("toneLabel"),
  canvasLabel: document.getElementById("canvasLabel"),
  canvasWidthInput: document.getElementById("canvasWidthInput"),
  canvasHeightInput: document.getElementById("canvasHeightInput"),
  applyCanvasSizeButton: document.getElementById("applyCanvasSizeButton"),
  uploadButton: document.getElementById("uploadButton"),
  updateButton: document.getElementById("updateButton"),
  mutateButton: document.getElementById("mutateButton"),
  exportButton: document.getElementById("exportButton"),
  clearButton: document.getElementById("clearButton"),
  statusNote: document.getElementById("statusNote"),
  densityRange: document.getElementById("densityRange"),
  overlapRange: document.getElementById("overlapRange"),
  variationRange: document.getElementById("variationRange"),
  airRange: document.getElementById("airRange"),
  resetControlsButton: document.getElementById("resetControlsButton"),
  inspector: document.getElementById("inspector"),
  workspaceNote: document.getElementById("workspaceNote"),
  layerCount: document.getElementById("layerCount"),
  layerList: document.getElementById("layerList"),
  layerEmpty: document.getElementById("layerEmpty"),
  appVersionLabel: document.getElementById("appVersionLabel"),
  appBuildLabel: document.getElementById("appBuildLabel"),
  fileInput: document.getElementById("fileInput"),
  retryButton: document.getElementById("retryButton"),
  undoButton: document.getElementById("undoButton"),
  redoButton: document.getElementById("redoButton"),
  replaceInput: document.getElementById("replaceInput"),
};

const runtimeVersion = getRuntimeVersion();

const savedSettings = loadSettings();

const state = {
  assets: [],
  tiles: [],
  selectedId: null,
  anchorId: null,
  cropMode: false,
  replaceTileId: null,
  interaction: null,
  dragDepth: 0,
  isDropTarget: false,
  upload: {
    active: false,
    total: 0,
    processed: 0,
    currentFile: "",
    currentIndex: 0,
    fileStartedAt: 0,
    stopRequested: false,
    // The phone's photo picker can take a while to hand over files after it closes.
    waitingForPicker: false,
  },
  failedFiles: [],
  layerDrag: {
    sourceId: null,
    targetId: null,
    placement: "before",
    suppressClickUntil: 0,
  },
  pendingRefresh: false,
  canvas: getInitialCanvasSize(savedSettings),
  nextAssetId: 1,
  nextTileId: 1,
  gridIndex: savedSettings.gridIndex ?? 0,
  controls: {
    density: savedSettings.density ?? defaultControls.density,
    overlap: savedSettings.overlap ?? defaultControls.overlap,
    variation: savedSettings.variation ?? defaultControls.variation,
    air: savedSettings.air ?? defaultControls.air,
    tone: toneModes.includes(savedSettings.tone) ? savedSettings.tone : "soft",
  },
};

syncControlsFromState();
syncCanvasInputs();
renderRuntimeVersion();
updateUploadLabel();
render();
bindEvents();

function bindEvents() {
  bindFilePickerTrigger(elements.uploadButton);
  bindFilePickerTrigger(elements.dropOverlay);
  elements.fileInput.addEventListener("change", handleUpload);
  elements.fileInput.addEventListener("click", startPickerWait);
  elements.fileInput.addEventListener("cancel", stopPickerWait);
  elements.stopUploadButton.addEventListener("click", requestUploadStop);
  elements.replaceInput.addEventListener("change", handleReplace);
  elements.retryButton?.addEventListener("click", retryFailedFiles);
  elements.undoButton.addEventListener("click", undo);
  elements.redoButton.addEventListener("click", redo);
  elements.updateButton.addEventListener("click", refreshComposition);
  elements.mutateButton.addEventListener("click", () => mutate());
  elements.exportButton.addEventListener("click", () => exportComposition());
  elements.clearButton.addEventListener("click", clearComposition);
  elements.gridButton.addEventListener("click", () => cycleGrid(1));
  elements.toneButton.addEventListener("click", cycleToneMode);
  elements.applyCanvasSizeButton.addEventListener("click", applyCanvasSize);
  elements.densityRange.addEventListener("input", handleControlInput);
  elements.overlapRange.addEventListener("input", handleControlInput);
  elements.variationRange.addEventListener("input", handleControlInput);
  elements.airRange.addEventListener("input", handleControlInput);
  elements.resetControlsButton.addEventListener("click", resetControls);
  elements.canvasWidthInput.addEventListener("keydown", handleCanvasSizeKeydown);
  elements.canvasHeightInput.addEventListener("keydown", handleCanvasSizeKeydown);
  elements.workspace.addEventListener("pointerdown", handleWorkspacePointerDown);
  elements.workspace.addEventListener("dblclick", handleWorkspaceDoubleClick);
  elements.workspace.addEventListener("wheel", handleCropWheel, { passive: false });
  elements.workspace.addEventListener("dragenter", handleWorkspaceDragEnter);
  elements.workspace.addEventListener("dragover", handleWorkspaceDragOver);
  elements.workspace.addEventListener("dragleave", handleWorkspaceDragLeave);
  elements.workspace.addEventListener("drop", handleWorkspaceDrop);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", endInteraction);
  window.addEventListener("pointercancel", endInteraction);
  window.addEventListener("resize", render);
  document.addEventListener("keydown", handleKeydown);
}

function bindFilePickerTrigger(element) {
  if (!element) {
    return;
  }

  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    if (!state.upload.active) openFilePicker();
  });
  element.addEventListener("click", (event) => {
    if (state.upload.active) event.preventDefault();
  });
}

function openFilePicker() {
  if (typeof elements.fileInput.showPicker === "function") {
    try {
      elements.fileInput.showPicker();
      return;
    } catch {
      // showPicker throws in cross-origin iframes and some mobile WebViews; fall back to click().
    }
  }

  elements.fileInput.click();
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {
    return {};
  }
}

function saveSettings() {
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      density: state.controls.density,
      overlap: state.controls.overlap,
      variation: state.controls.variation,
      air: state.controls.air,
      tone: state.controls.tone,
      gridIndex: state.gridIndex,
      canvasWidth: state.canvas.width,
      canvasHeight: state.canvas.height,
    }),
  );
}

function getRuntimeVersion() {
  const fallbackVersion =
    document.querySelector('meta[name="application-version"]')?.getAttribute("content") || "dev";
  const payload = window.__INTERSECTION_MAP_VERSION__ || {};
  return {
    version: payload.version || fallbackVersion,
    builtAt: payload.builtAt || "",
  };
}

function renderRuntimeVersion() {
  if (elements.appVersionLabel) {
    elements.appVersionLabel.textContent = runtimeVersion.version;
  }
  if (elements.appBuildLabel) {
    elements.appBuildLabel.textContent = runtimeVersion.builtAt
      ? `· ${formatBuildStamp(runtimeVersion.builtAt)}`
      : "";
  }
}

function formatBuildStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

function syncControlsFromState() {
  elements.densityRange.value = state.controls.density;
  elements.overlapRange.value = state.controls.overlap;
  elements.variationRange.value = state.controls.variation;
  elements.airRange.value = state.controls.air;
}

function getInitialCanvasSize(settings) {
  const width = Number(settings.canvasWidth ?? defaultCanvasSize.width);
  const height = Number(settings.canvasHeight ?? defaultCanvasSize.height);
  return sanitizeCanvasSize(width, height);
}

function syncCanvasInputs() {
  elements.canvasWidthInput.value = String(state.canvas.width);
  elements.canvasHeightInput.value = String(state.canvas.height);
}

function handleCanvasSizeKeydown(event) {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  applyCanvasSize();
}

function applyCanvasSize() {
  const requestedWidth = Number(elements.canvasWidthInput.value);
  const requestedHeight = Number(elements.canvasHeightInput.value);

  if (!Number.isFinite(requestedWidth) || !Number.isFinite(requestedHeight)) {
    syncCanvasInputs();
    setStatus("Enter both width and height in pixels.", true);
    return;
  }

  const nextSize = sanitizeCanvasSize(requestedWidth, requestedHeight);
  const clamped =
    nextSize.width !== Math.round(requestedWidth) || nextSize.height !== Math.round(requestedHeight);
  const changed =
    nextSize.width !== state.canvas.width || nextSize.height !== state.canvas.height;

  if (changed) {
    recordHistory("field size");
  }
  state.canvas = nextSize;
  clampTilesToGrid();
  syncCanvasInputs();
  saveSettings();
  render();
  setStatus(
    clamped
      ? `Field size set to ${nextSize.width} × ${nextSize.height}px. Kept within the safe export range.`
      : changed
        ? `Field size set to ${nextSize.width} × ${nextSize.height}px.`
        : `Field size remains ${nextSize.width} × ${nextSize.height}px.`,
    false,
  );
}

function sanitizeCanvasSize(width, height) {
  const safeWidth = Number.isFinite(width) ? width : defaultCanvasSize.width;
  const safeHeight = Number.isFinite(height) ? height : defaultCanvasSize.height;
  return {
    width: clamp(canvasSizeLimits.min, Math.round(safeWidth), canvasSizeLimits.max),
    height: clamp(canvasSizeLimits.min, Math.round(safeHeight), canvasSizeLimits.max),
  };
}

function handleControlInput() {
  state.controls.density = Number(elements.densityRange.value);
  state.controls.overlap = Number(elements.overlapRange.value);
  state.controls.variation = Number(elements.variationRange.value);
  state.controls.air = Number(elements.airRange.value);
  state.pendingRefresh = true;
  saveSettings();
  renderMeta();
  setStatus(
    `Size ${describeControlLevel(state.controls.density)}, overlap ${describeControlLevel(state.controls.overlap)}, variation ${describeControlLevel(state.controls.variation)}, air ${describeControlLevel(state.controls.air)}. Press arrange to apply.`,
    false,
  );
}

let pickerWaitTimer = 0;

function startPickerWait() {
  if (state.upload.active) return;
  window.clearTimeout(pickerWaitTimer);
  state.upload.waitingForPicker = true;
  renderWorkspaceClasses();
  // Browsers without a "cancel" event never tell us the picker was dismissed; give up quietly.
  pickerWaitTimer = window.setTimeout(stopPickerWait, 60000);
  window.addEventListener("pointerdown", stopPickerWaitOnInteraction, { once: true, capture: true });
}

function stopPickerWaitOnInteraction(event) {
  if (event.target === elements.fileInput) return;
  stopPickerWait();
}

function stopPickerWait() {
  window.clearTimeout(pickerWaitTimer);
  window.removeEventListener("pointerdown", stopPickerWaitOnInteraction, { capture: true });
  if (!state.upload.waitingForPicker) return;
  state.upload.waitingForPicker = false;
  renderWorkspaceClasses();
}

function requestUploadStop() {
  if (!state.upload.active || state.upload.stopRequested) return;
  state.upload.stopRequested = true;
  renderUploadOverlay();
  setStatus("Stopping after this image…", false);
}

async function handleUpload(event) {
  stopPickerWait();
  const input = event.target;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  // Keep the input populated until the batch is processed: mobile browsers (iOS Safari, Android
  // photo pickers) may invalidate the temporary File copies once the input is cleared, which made
  // later photos in a batch fail with "Failed to load". Clearing afterwards still lets the user
  // pick the same files again.
  await enqueueUpload(() => processIncomingFiles(files));
  if (input.files?.length && Array.from(input.files).every((file, index) => file === files[index])) {
    input.value = "";
  }
}

async function handleReplace(event) {
  const input = event.target;
  const file = input.files?.[0];
  const tileId = state.replaceTileId;
  state.replaceTileId = null;
  if (!file || !tileId) {
    input.value = "";
    return;
  }
  await enqueueUpload(async () => {
    const tile = getTile(tileId);
    if (!tile) return;
    beginUploadProgress(1);
    updateUploadProgress(0, 1, file.name);
    await nextFrame();
    try {
      if (!(await looksLikeImageFileAsync(file))) throw new Error("Choose an image file to use instead.");
      const asset = await createAsset(file);
      const previousAssetId = tile.assetId;
      recordHistory("replace");
      registerAsset(asset);
      state.assets.push(asset);
      tile.assetId = asset.id;
      releaseUnusedAsset(previousAssetId);
      setStatus(`Replaced ${tile.label}${asset.optimized ? ". Optimized for smoother editing" : ""}.`, false);
    } catch (error) {
      console.error("Replace failed", file.name, error);
      setStatus(`${file.name}: ${describeUploadError(error)}`, true);
    } finally {
      endUploadProgress();
    }
  });
  input.value = "";
}

function enqueueUpload(task) {
  uploadQueue = uploadQueue.catch(() => {}).then(task).catch((error) => {
    console.error("Upload task failed", error);
    if (state.upload.active) endUploadProgress();
    setStatus(describeUploadError(error, "Could not prepare images. Please try again."), true);
  });
  return uploadQueue;
}

class UploadError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message);
    this.name = "UploadError";
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

function describeUploadError(error, fallback = "Could not open this image.") {
  if (error instanceof UploadError) return error.message;
  if (error?.name === "NotReadableError" || error?.name === "NotFoundError") {
    return "the file could not be read. If it is stored in iCloud or Google Photos, wait for it to download and retry.";
  }
  if (error?.name === "QuotaExceededError" || /memory|allocation/i.test(error?.message || "")) {
    return "not enough memory to open this image. Try fewer images at once.";
  }
  return error?.message || fallback;
}

function isRetryableError(error) {
  if (error instanceof UploadError) return error.retryable;
  return error?.name === "NotReadableError" || error?.name === "TimeoutError";
}

function withTimeout(promise, timeoutMs, message) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new UploadError(message, { retryable: true })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function createAsset(file) {
  if (file.size > uploadLimits.maxFileSizeBytes) {
    throw new UploadError(`file is too large (${formatMegabytes(file.size)} MB, max ${formatMegabytes(uploadLimits.maxFileSizeBytes)} MB).`);
  }
  if (file.size === 0) {
    throw new UploadError("file is empty. If it is stored in iCloud or Google Photos, wait for it to download and retry.", { retryable: true });
  }

  const prepared = await prepareAssetSource(file);
  try {
    return {
      id: state.nextAssetId++,
      name: file.name,
      url: prepared.url,
      img: prepared.img,
      width: prepared.width,
      height: prepared.height,
      optimized: prepared.optimized,
      resized: prepared.resized,
      originalByteSize: file.size,
      byteSize: prepared.blob.size,
      tone: analyzeToneProfile(prepared.img),
    };
  } catch (error) {
    URL.revokeObjectURL(prepared.url);
    throw error;
  }
}

function looksLikeImageFile(file) {
  if (!file) {
    return false;
  }

  if (file.type?.startsWith("image/")) {
    return true;
  }

  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(file.name || "");
}

// Some Android pickers and file managers hand over photos with no extension and an empty or
// generic MIME type ("image:1234", application/octet-stream). Sniff the header instead of
// silently dropping them as "non-image".
async function looksLikeImageFileAsync(file) {
  if (looksLikeImageFile(file)) return true;
  if (!file || file.size < 12) return false;
  if (file.type && file.type !== "application/octet-stream") return false;
  try {
    return Boolean(await sniffImageType(file));
  } catch {
    return false;
  }
}

async function sniffImageType(file) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return "image/heic";
    if (/^(avif|avis)$/.test(brand)) return "image/avif";
  }
  return "";
}

async function isHeicContent(file) {
  if (isHeicFile(file)) return true;
  try {
    return (await sniffImageType(file)) === "image/heic";
  } catch {
    return false;
  }
}

// Load a blob as an <img>, retrying once from an in-memory copy. On mobile, a File backed by a
// photo-library/cloud provider can fail the first read (NotReadableError / img error) and succeed
// once its bytes are copied.
async function loadImageWithRetry(file) {
  let lastError = null;
  for (let attempt = 0; attempt < uploadLimits.fileReadAttempts; attempt += 1) {
    try {
      const blob = attempt === 0 ? file : await copyFileToMemory(file);
      const source = await loadImageSource(blob, file.name);
      return { source, blob };
    } catch (error) {
      lastError = error;
      if (error?.name === "NotFoundError") break;
      await delay(150);
    }
  }
  throw lastError;
}

async function copyFileToMemory(file) {
  const buffer = await file.arrayBuffer();
  if (!buffer.byteLength) {
    throw new UploadError("file is empty. If it is stored in iCloud or Google Photos, wait for it to download and retry.", { retryable: true });
  }
  return new Blob([buffer], { type: file.type || (await sniffImageType(file)) || "" });
}

async function prepareAssetSource(file) {
  let blob = file;
  let converted = false;
  let source;
  const heic = await isHeicContent(file);
  try {
    // Safari decodes HEIC natively; other browsers fail fast and fall through to the WASM decoder.
    ({ source, blob } = await loadImageWithRetry(file));
  } catch (error) {
    if (!heic) {
      if (error instanceof UploadError || error?.name === "NotReadableError") throw error;
      throw new UploadError("this image format is not supported by your browser, or the file is damaged.", { cause: error });
    }
    blob = await convertHeic(file);
    converted = true;
    source = await loadImageSource(blob, file.name);
  }
  const shouldOptimize = shouldOptimizeImage(file, source.width, source.height);

  if (!shouldOptimize) {
    return {
      ...source,
      blob,
      optimized: converted,
      resized: false,
    };
  }

  const targetSize = getOptimizedDimensions(source.width, source.height);
  const resized =
    targetSize.width !== source.width || targetSize.height !== source.height;
  const optimizedBlob = await renderOptimizedBlob(file, source.img, targetSize);

  if (!optimizedBlob) {
    return {
      ...source,
      blob,
      optimized: converted,
      resized: false,
    };
  }

  if (!resized && optimizedBlob.size >= blob.size * 0.98) {
    return {
      ...source,
      blob,
      optimized: converted,
      resized: false,
    };
  }

  let optimizedSource;
  try {
    optimizedSource = await loadImageSource(optimizedBlob, file.name);
  } catch {
    return { ...source, blob, optimized: converted, resized: false };
  }
  URL.revokeObjectURL(source.url);
  return {
    ...optimizedSource,
    blob: optimizedBlob,
    optimized: true,
    resized,
  };
}

function isHeicFile(file) {
  return /\.(heic|heif)$/i.test(file.name || "") || /^image\/(heic|heif)$/i.test(file.type || "");
}

function resolveAppAssetUrl(relativePath) {
  return new URL(relativePath, appScriptBaseUrl).href;
}

function loadScriptOnce(src, globalName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) {
        script.remove();
        reject(error);
        return;
      }
      resolve(window[globalName]);
    };
    const timer = window.setTimeout(
      () => finish(new UploadError("HEIC decoder download timed out. Check your connection and retry.", { retryable: true })),
      timeoutMs,
    );
    script.async = true;
    script.src = src;
    script.dataset.heicDecoder = globalName;
    script.onload = () => window[globalName]
      ? finish()
      : finish(new UploadError("HEIC decoder unavailable. Please retry.", { retryable: true }));
    script.onerror = () => finish(new UploadError("HEIC decoder could not load. Check your connection and retry.", { retryable: true }));
    document.head.append(script);
  });
}

function loadHeicDecoder(kind = "primary") {
  const config = heicDecoders[kind];
  if (window[config.global]) return Promise.resolve(window[config.global]);
  if (!heicDecoderPromises.has(kind)) {
    const promise = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt < uploadLimits.decoderScriptAttempts; attempt += 1) {
        if (attempt > 0) {
          if (!navigator.onLine) break;
          await delay(600 * 2 ** (attempt - 1));
        }
        const url = new URL(resolveAppAssetUrl(config.path));
        if (attempt > 0) url.searchParams.set("retry", String(Date.now()));
        try {
          return await loadScriptOnce(url.href, config.global, uploadLimits.decoderScriptTimeoutMs);
        } catch (error) {
          lastError = error;
          console.warn(`HEIC decoder load attempt ${attempt + 1} failed`, error);
        }
      }
      throw lastError || new UploadError("HEIC decoder could not load. Check your connection and retry.", { retryable: true });
    })().catch((error) => {
      // Never cache a failure: the next upload (or the retry button) starts a fresh download.
      heicDecoderPromises.delete(kind);
      throw error;
    });
    heicDecoderPromises.set(kind, promise);
  }
  return heicDecoderPromises.get(kind);
}

async function convertHeic(file) {
  const input = await copyFileToMemory(file).catch((error) => {
    throw error instanceof UploadError ? error : new UploadError(describeUploadError(error), { retryable: true, cause: error });
  });

  let primaryError = null;
  try {
    const heicTo = await loadHeicDecoder("primary");
    const blob = await withTimeout(
      heicTo({ blob: input, type: "image/jpeg", quality: 0.92 }),
      uploadLimits.heicDecodeTimeoutMs,
      "HEIC decoding took too long. Try fewer images at once.",
    );
    if (blob instanceof Blob && blob.size) return blob;
    primaryError = new Error("Empty HEIC decoder output");
  } catch (error) {
    if (error instanceof UploadError && /could not load|timed out|unavailable/i.test(error.message)) throw error;
    primaryError = error;
  }

  console.warn("HEIC primary decoder failed, trying fallback", primaryError);
  try {
    const heic2any = await loadHeicDecoder("fallback");
    const result = await withTimeout(
      heic2any({ blob: input, toType: "image/jpeg", quality: 0.92 }),
      uploadLimits.heicDecodeTimeoutMs,
      "HEIC decoding took too long. Try fewer images at once.",
    );
    const blob = Array.isArray(result) ? result[0] : result;
    if (blob instanceof Blob && blob.size) return blob;
    throw new Error("Empty HEIC decoder output");
  } catch (error) {
    console.error("HEIC decoding failed", primaryError, error);
    if (error instanceof UploadError && error.retryable) throw error;
    throw new UploadError("HEIC image could not be decoded. Try exporting it as JPEG.", { cause: error });
  }
}

function shouldOptimizeImage(file, width, height) {
  if (!canOptimizeBitmap(file)) {
    return false;
  }

  const longestSide = Math.max(width, height);
  return (
    longestSide > imageOptimization.maxDimension ||
    file.size > imageOptimization.maxFileSizeBytes
  );
}

function canOptimizeBitmap(file) {
  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();

  if (mime === "image/gif" || mime === "image/svg+xml") {
    return false;
  }

  return /\.(avif|bmp|heic|heif|jpe?g|png|tiff?|webp)$/i.test(name) ||
    /^image\/(avif|bmp|heic|heif|jpeg|png|tiff|webp)$/.test(mime);
}

function getOptimizedDimensions(width, height) {
  const longestSide = Math.max(width, height);
  if (longestSide <= imageOptimization.maxDimension) {
    return { width, height };
  }

  const scale = imageOptimization.maxDimension / longestSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function renderOptimizedBlob(file, img, targetSize) {
  const canvas = document.createElement("canvas");
  try {
    canvas.width = targetSize.width;
    canvas.height = targetSize.height;

    const preserveAlpha = preservesAlpha(file);
    const context = canvas.getContext("2d", { alpha: preserveAlpha });
    if (!context) return null;

  if (!preserveAlpha) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(img, 0, 0, targetSize.width, targetSize.height);

  const preferredType = preserveAlpha ? "image/webp" : "image/jpeg";
  const preferredQuality = preserveAlpha
    ? imageOptimization.webpQuality
    : imageOptimization.jpegQuality;

  const blob =
    (await canvasToBlob(canvas, preferredType, preferredQuality)) ||
    (await canvasToBlob(canvas, "image/jpeg", imageOptimization.jpegQuality));

    return blob;
  } catch {
    return null;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

function preservesAlpha(file) {
  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return (
    mime === "image/png" ||
    mime === "image/webp" ||
    mime === "image/avif" ||
    /\.png$|\.webp$|\.avif$/i.test(name)
  );
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

function loadImageSource(blob, label = "image") {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      img.removeAttribute("src");
      URL.revokeObjectURL(url);
      reject(error);
    };
    // iOS Safari occasionally never fires load/error for very large photos under memory pressure.
    const timer = window.setTimeout(
      () => fail(new UploadError("opening the image took too long. Try again or use a smaller file.", { retryable: true })),
      uploadLimits.imageLoadTimeoutMs,
    );
    img.decoding = "async";
    img.onload = () => {
      if (settled) return;
      if (!img.naturalWidth || !img.naturalHeight) {
        fail(new Error(`Failed to load ${label}`));
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      resolve({
        url,
        img,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };
    img.onerror = () => fail(new Error(`Failed to load ${label}`));
    img.src = url;
  });
}

function formatOptimizationStatus(assets) {
  if (!assets.length) {
    return "";
  }

  const resizedCount = assets.filter((asset) => asset.resized).length;
  const originalBytes = assets.reduce(
    (total, asset) => total + asset.originalByteSize,
    0,
  );
  const optimizedBytes = assets.reduce(
    (total, asset) => total + asset.byteSize,
    0,
  );
  const savedBytes = Math.max(0, originalBytes - optimizedBytes);
  const resizedNote = resizedCount
    ? `Reduced ${resizedCount} large image${resizedCount === 1 ? "" : "s"} to max ${imageOptimization.maxDimension}px`
    : `Compressed ${assets.length} image${assets.length === 1 ? "" : "s"}`;

  if (savedBytes < 1024 * 1024) {
    return `${resizedNote}. `;
  }

  return `${resizedNote} and saved about ${formatMegabytes(savedBytes)} MB. `;
}

function formatMegabytes(bytes) {
  return round(bytes / (1024 * 1024), 1);
}

function analyzeToneProfile(img) {
  const longestSide = 32;
  const scale = Math.min(1, longestSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    return { brightness: 0.5, contrast: 0.2, darkRatio: 0.33, lightRatio: 0.33 };
  }

  context.drawImage(img, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  let total = 0;
  let totalSquared = 0;
  let dark = 0;
  let light = 0;
  const pixels = Math.max(1, data.length / 4);

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] / 255;
    const luminance =
      (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) * alpha +
      255 * (1 - alpha);
    total += luminance;
    totalSquared += luminance * luminance;
    if (luminance < 85) {
      dark += 1;
    } else if (luminance > 170) {
      light += 1;
    }
  }

  const mean = total / pixels;
  const variance = Math.max(0, totalSquared / pixels - mean * mean);
  canvas.width = 1;
  canvas.height = 1;

  return {
    brightness: round(mean / 255, 3),
    contrast: round(Math.sqrt(variance) / 255, 3),
    darkRatio: round(dark / pixels, 3),
    lightRatio: round(light / pixels, 3),
  };
}

function createTile(assetId) {
  const number = String(state.nextTileId).padStart(2, "0");
  return {
    id: state.nextTileId++,
    label: `image ${number}`,
    assetId,
    x: 1,
    y: 1,
    width: 4,
    height: 3,
    zIndex: state.tiles.length + 1,
    locked: false,
    isAnchor: false,
    cropX: 0.5,
    cropY: 0.5,
    cropScale: 1,
    movedManually: false,
    resizedManually: false,
  };
}

// Presets fix the column count; rows follow the field's proportions so cells stay (nearly) square
// at any field size, instead of stretching into rectangles on non-4:3 fields.
function getGrid() {
  if (layoutGridOverride) {
    return layoutGridOverride;
  }
  const preset = gridPresets[state.gridIndex] || gridPresets[0];
  const ratio = state.canvas.height / state.canvas.width;
  return { cols: preset.cols, rows: clamp(2, Math.round(preset.cols * ratio), 60) };
}

function clampTilesToGrid() {
  const { cols, rows } = getGrid();
  state.tiles.forEach((tile) => {
    tile.width = clamp(1, tile.width, cols);
    tile.height = clamp(1, tile.height, rows);
    tile.x = clamp(-tile.width + 1, tile.x, cols - 1);
    tile.y = clamp(-tile.height + 1, tile.y, rows - 1);
  });
}

function getMetrics() {
  const grid = getGrid();
  const rect = elements.workspace.getBoundingClientRect();
  return {
    ...grid,
    rect,
    colPx: rect.width / grid.cols,
    rowPx: rect.height / grid.rows,
  };
}

function getLayoutGuide(cols, rows) {
  const metrics = getMetrics();
  const compactViewport = metrics.rect.width <= 520 || metrics.rect.height <= 420;
  const minimumTilePixels = compactViewport ? 54 : 24;
  const minimumVisiblePixels = compactViewport ? 42 : 16;

  return {
    compactViewport,
    minTileCols: clamp(1, Math.ceil(minimumTilePixels / Math.max(1, metrics.colPx)), cols),
    minTileRows: clamp(1, Math.ceil(minimumTilePixels / Math.max(1, metrics.rowPx)), rows),
    minVisibleCols: clamp(1, Math.ceil(minimumVisiblePixels / Math.max(1, metrics.colPx)), cols),
    minVisibleRows: clamp(1, Math.ceil(minimumVisiblePixels / Math.max(1, metrics.rowPx)), rows),
  };
}

function getTile(id) {
  return state.tiles.find((tile) => tile.id === Number(id)) || null;
}

function getAsset(id) {
  return state.assets.find((asset) => asset.id === id) || null;
}

function getSelectedTile() {
  return state.selectedId ? getTile(state.selectedId) : null;
}

function setSelectedTile(tileId) {
  state.selectedId = tileId ? Number(tileId) : null;
  if (!state.selectedId) {
    state.cropMode = false;
  }
  renderTilesOnly();
  renderSelectionOverlay();
  renderInspector();
  renderWorkspaceClasses();
  renderLayerStrip();
}

function handleWorkspacePointerDown(event) {
  if (event.target === elements.dropOverlay) {
    return;
  }

  const overlayHandle = event.target.closest(".selection-overlay [data-handle]")?.dataset.handle || null;
  if (overlayHandle) {
    const selectedTile = getSelectedTile();
    if (selectedTile && !selectedTile.locked && !state.cropMode) {
      beginResize(selectedTile, overlayHandle, event);
    }
    return;
  }

  const tileEl = event.target.closest(".tile");
  if (!tileEl) {
    setSelectedTile(null);
    return;
  }

  const tile = getTile(tileEl.dataset.tileId);
  if (!tile) {
    return;
  }

  setSelectedTile(tile.id);

  const handle = detectResizeHandle(tileEl, event);
  const canMove = !tile.locked;

  if (handle && canMove && !state.cropMode) {
    beginResize(tile, handle, event);
    return;
  }

  if (state.cropMode && state.selectedId === tile.id) {
    beginCropDrag(tile, event);
    return;
  }

  if (canMove) {
    beginDrag(tile, event);
  }
}

function handleWorkspaceDoubleClick(event) {
  const tileEl = event.target.closest(".tile");
  if (!tileEl) {
    return;
  }

  const tile = getTile(tileEl.dataset.tileId);
  if (!tile) {
    return;
  }

  setSelectedTile(tile.id);
  ensureCropFreedom(tile);
  state.cropMode = true;
  renderTilesOnly();
  renderWorkspaceClasses();
  renderInspector();
}

function detectResizeHandle(tileEl, event) {
  const explicitHandle = event.target.closest("[data-handle]")?.dataset.handle || null;
  if (explicitHandle) {
    return explicitHandle;
  }

  const rect = tileEl.getBoundingClientRect();
  const edgeThreshold = 16;
  const distanceRight = rect.right - event.clientX;
  const distanceBottom = rect.bottom - event.clientY;
  const nearRight = distanceRight >= 0 && distanceRight <= edgeThreshold;
  const nearBottom = distanceBottom >= 0 && distanceBottom <= edgeThreshold;

  if (nearRight && nearBottom) {
    return "xy";
  }
  if (nearRight) {
    return "x";
  }
  if (nearBottom) {
    return "y";
  }
  return null;
}

function beginDrag(tile, event) {
  const { colPx, rowPx } = getMetrics();
  state.interaction = {
    type: "drag",
    tileId: tile.id,
    startPointerX: event.clientX,
    startPointerY: event.clientY,
    startX: tile.x,
    startY: tile.y,
    colPx,
    rowPx,
    hasMoved: false,
    before: captureComposition("move"),
  };
}

function beginResize(tile, axis, event) {
  const { colPx, rowPx } = getMetrics();
  state.interaction = {
    type: "resize",
    axis,
    tileId: tile.id,
    startPointerX: event.clientX,
    startPointerY: event.clientY,
    startWidth: tile.width,
    startHeight: tile.height,
    colPx,
    rowPx,
    before: captureComposition("resize"),
  };
}

function beginCropDrag(tile, event) {
  const before = captureComposition("crop");
  ensureCropFreedom(tile);
  state.interaction = {
    before,
    type: "crop",
    tileId: tile.id,
    startPointerX: event.clientX,
    startPointerY: event.clientY,
    startCropX: tile.cropX,
    startCropY: tile.cropY,
  };
}

function handlePointerMove(event) {
  if (!state.interaction) {
    return;
  }

  const tile = getTile(state.interaction.tileId);
  if (!tile) {
    return;
  }

  if (state.interaction.type === "drag") {
    const pointerDistance = Math.hypot(
      event.clientX - state.interaction.startPointerX,
      event.clientY - state.interaction.startPointerY,
    );
    if (!state.interaction.hasMoved && pointerDistance < 4) {
      return;
    }
    state.interaction.hasMoved = true;
    const dx = (event.clientX - state.interaction.startPointerX) / state.interaction.colPx;
    const dy = (event.clientY - state.interaction.startPointerY) / state.interaction.rowPx;
    tile.x = clamp(
      -tile.width + 1,
      snapToStep(state.interaction.startX + dx, dragGranularity),
      getGrid().cols - 1,
    );
    tile.y = clamp(
      -tile.height + 1,
      snapToStep(state.interaction.startY + dy, dragGranularity),
      getGrid().rows - 1,
    );
    tile.movedManually = true;
    renderTile(tile);
    renderSelectionOverlay();
    return;
  }

  if (state.interaction.type === "resize") {
    const deltaCols = Math.round(
      (event.clientX - state.interaction.startPointerX) / state.interaction.colPx,
    );
    const deltaRows = Math.round(
      (event.clientY - state.interaction.startPointerY) / state.interaction.rowPx,
    );

    if (state.interaction.axis.includes("x")) {
      tile.width = clamp(1, state.interaction.startWidth + deltaCols, getGrid().cols);
    }
    if (state.interaction.axis.includes("y")) {
      tile.height = clamp(1, state.interaction.startHeight + deltaRows, getGrid().rows);
    }

    tile.resizedManually = true;
    tile.x = clamp(-tile.width + 1, tile.x, getGrid().cols - 1);
    tile.y = clamp(-tile.height + 1, tile.y, getGrid().rows - 1);
    renderTile(tile);
    renderSelectionOverlay();
    return;
  }

  if (state.interaction.type === "crop") {
    updateCropDrag(tile, event);
    renderTile(tile);
    renderSelectionOverlay();
  }
}

function endInteraction() {
  const interaction = state.interaction;
  state.interaction = null;
  if (!interaction?.before) {
    return;
  }
  const before = interaction.before.tiles.find((tile) => tile.id === interaction.tileId);
  const now = getTile(interaction.tileId);
  const changed =
    before && now && ["x", "y", "width", "height", "cropX", "cropY", "cropScale"].some((key) => before[key] !== now[key]);
  if (changed) {
    undoHistory.mergeKey = null;
    pushHistorySnapshot(interaction.before);
  }
}

function updateCropDrag(tile, event) {
  const metrics = getMetrics();
  const tileWidthPx = tile.width * metrics.colPx;
  const tileHeightPx = tile.height * metrics.rowPx;
  const asset = getAsset(tile.assetId);

  if (!asset) {
    return;
  }

  const cover = getCoverFrame(asset, tileWidthPx, tileHeightPx, tile.cropScale);
  const overflowX = Math.max(0, cover.drawWidth - tileWidthPx);
  const overflowY = Math.max(0, cover.drawHeight - tileHeightPx);
  const dx = event.clientX - state.interaction.startPointerX;
  const dy = event.clientY - state.interaction.startPointerY;

  if (overflowX > 0) {
    tile.cropX = clamp(0, state.interaction.startCropX - dx / overflowX, 1);
  }
  if (overflowY > 0) {
    tile.cropY = clamp(0, state.interaction.startCropY - dy / overflowY, 1);
  }
}

function handleCropWheel(event) {
  if (!state.cropMode) {
    return;
  }

  const tileEl = event.target.closest(".tile");
  const tile = getSelectedTile();

  if (!tileEl || !tile || tile.id !== Number(tileEl.dataset.tileId)) {
    return;
  }

  event.preventDefault();
  const delta = event.deltaY < 0 ? 0.05 : -0.05;
  recordHistory("crop", `crop-${tile.id}`);
  tile.cropScale = clamp(1, round(tile.cropScale + delta, 2), 2.6);
  renderTilesOnly();
}

function handleKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && !isTypingTarget(event.target)) {
    const redoKey = (event.code === "KeyZ" && event.shiftKey) || (event.ctrlKey && event.code === "KeyY");
    if (event.code === "KeyZ" || redoKey) {
      event.preventDefault();
      if (redoKey) redo();
      else undo();
      return;
    }
  }

  if (event.key === "Escape") {
    state.cropMode = false;
    renderTilesOnly();
    clearDropTarget();
    renderWorkspaceClasses();
    renderInspector();
    return;
  }

  if (handleTileKeys(event)) {
    event.preventDefault();
  }
}

const arrowDeltas = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function isTypingTarget(element) {
  return Boolean(
    element &&
      (element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT" ||
        element.isContentEditable),
  );
}

// Keyboard equivalents of the pointer gestures on the selected tile:
// arrows move (Alt: quarter cell), Shift + arrows resize, [ / ] change depth;
// in crop mode arrows pan the photo and + / − zoom it.
function handleTileKeys(event) {
  if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || state.upload.active) {
    return false;
  }

  const tile = getSelectedTile();
  if (!tile) {
    return false;
  }

  // Physical key codes, so [ ] + − work on any keyboard layout (e.g. Russian, where [ types "х").
  if (event.code === "BracketLeft" || event.code === "BracketRight") {
    moveTileDepth(tile, event.code === "BracketRight" ? 1 : -1);
    return true;
  }

  const zoomIn = event.code === "Equal" || event.code === "NumpadAdd" || event.key === "+";
  const zoomOut = event.code === "Minus" || event.code === "NumpadSubtract" || event.key === "-";
  if (state.cropMode && (zoomIn || zoomOut)) {
    const delta = zoomOut ? -0.05 : 0.05;
    recordHistory("crop", `crop-${tile.id}`);
    tile.cropScale = clamp(1, round(tile.cropScale + delta, 2), 2.6);
    renderTilesOnly();
    renderInspector();
    return true;
  }

  const delta = arrowDeltas[event.key];
  if (!delta) {
    return false;
  }
  const [dx, dy] = delta;

  if (state.cropMode) {
    recordHistory("crop", `crop-${tile.id}`);
    tile.cropX = clamp(0, round(tile.cropX + dx * 0.05, 3), 1);
    tile.cropY = clamp(0, round(tile.cropY + dy * 0.05, 3), 1);
    renderTile(tile);
    renderSelectionOverlay();
    return true;
  }

  if (tile.locked) {
    setStatus(`${tile.label} is locked. Unlock it to move or resize.`, false);
    return true;
  }

  const { cols, rows } = getGrid();
  recordHistory(event.shiftKey ? "resize" : "move", `${event.shiftKey ? "resize" : "move"}-${tile.id}`);
  if (event.shiftKey) {
    tile.width = clamp(1, tile.width + dx, cols);
    tile.height = clamp(1, tile.height + dy, rows);
    tile.resizedManually = true;
  } else {
    const step = event.altKey ? dragGranularity : 1;
    tile.x = snapToStep(tile.x + dx * step, dragGranularity);
    tile.y = snapToStep(tile.y + dy * step, dragGranularity);
    tile.movedManually = true;
  }
  tile.x = clamp(-tile.width + 1, tile.x, cols - 1);
  tile.y = clamp(-tile.height + 1, tile.y, rows - 1);

  renderTile(tile);
  renderSelectionOverlay();
  if (event.shiftKey) {
    renderInspector();
    renderLayerStrip();
  }
  return true;
}

function moveTileDepth(tile, direction) {
  const ordered = [...state.tiles].sort((left, right) => left.zIndex - right.zIndex);
  const index = ordered.indexOf(tile);
  const neighbour = ordered[index + direction];
  if (!neighbour) {
    setStatus(`${tile.label} is already ${direction > 0 ? "on top" : "at the bottom"}.`, false);
    return;
  }
  recordHistory("layer order", `depth-${tile.id}`);
  [tile.zIndex, neighbour.zIndex] = [neighbour.zIndex, tile.zIndex];
  render();
  setStatus(`Layer order updated. ${tile.label} moved ${direction > 0 ? "up" : "down"}.`, false);
}

function handleWorkspaceDragEnter(event) {
  if (!containsImageFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  state.dragDepth += 1;
  state.isDropTarget = true;
  renderWorkspaceClasses();
}

function handleWorkspaceDragOver(event) {
  if (!containsImageFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  if (!state.isDropTarget) {
    state.isDropTarget = true;
    renderWorkspaceClasses();
  }
}

function handleWorkspaceDragLeave(event) {
  if (!containsImageFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth === 0) {
    clearDropTarget();
  }
}

async function handleWorkspaceDrop(event) {
  if (!containsImageFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  clearDropTarget();
  await enqueueUpload(() => processIncomingFiles(files));
}

async function processIncomingFiles(selectedFiles, { isRetry = false } = {}) {
  const typeChecks = await Promise.all(selectedFiles.map((file) => looksLikeImageFileAsync(file)));
  const files = selectedFiles.filter((_, index) => typeChecks[index]);
  const skippedByType = selectedFiles.length - files.length;

  if (!files.length) {
    setStatus("Drop or choose image files to add them to the grid.", true);
    return;
  }

  const isInitialUpload = state.tiles.length === 0;
  const newTileIds = [];
  const failedFiles = [];
  const retryableFiles = [];
  const optimizedAssets = [];
  let recordedUpload = false;
  let stoppedAt = -1;

  if (!isRetry) setFailedFiles([]);
  beginUploadProgress(files.length);
  await nextFrame();
  try {
    for (const [index, file] of files.entries()) {
      if (state.upload.stopRequested) {
        stoppedAt = index;
        break;
      }
      updateUploadProgress(index, files.length, file.name);
      await nextFrame();
      try {
        const asset = await createAsset(file);
        if (!recordedUpload) {
          recordHistory("add images");
          recordedUpload = true;
        }
        registerAsset(asset);
        state.assets.push(asset);
        const tile = createTile(asset.id);
        state.tiles.push(tile);
        newTileIds.push(tile.id);
        addLoadingThumb(asset);
        if (asset.optimized) {
          optimizedAssets.push(asset);
        }
      } catch (error) {
        console.error("Photo upload failed", file.name, error);
        failedFiles.push(`${file.name}: ${describeUploadError(error, "could not open image")}`);
        if (isRetryableError(error)) retryableFiles.push(file);
      }
    }
  } finally {
    endUploadProgress();
  }

  setFailedFiles(retryableFiles);

  if (!newTileIds.length) {
    setStatus(`Could not add images. ${failedFiles.slice(0, 2).join("; ") || "Choose supported image files."}`, true);
    return;
  }

  updateUploadLabel();
  if (isInitialUpload) {
    scatter();
  } else {
    layoutTiles(newTileIds);
    normalizeLayerOrder();
    render();
  }

  const optimizationMessage = formatOptimizationStatus(optimizedAssets);
  if (stoppedAt >= 0) {
    const notAdded = files.length - stoppedAt;
    setStatus(
      `Stopped. Added ${newTileIds.length} image${newTileIds.length === 1 ? "" : "s"}, ${notAdded} not added.${failedFiles.length ? ` Could not open ${failedFiles.length}.` : ""}`,
      false,
    );
    return;
  }
  const skippedCount = skippedByType + failedFiles.length;
  if (skippedCount) {
    setStatus(
      `Added ${newTileIds.length} image${newTileIds.length === 1 ? "" : "s"}. ${optimizationMessage}${skippedByType ? `${skippedByType} non-image file${skippedByType === 1 ? "" : "s"} skipped. ` : ""}${failedFiles.length ? `Could not open: ${failedFiles.slice(0, 2).join("; ")}${failedFiles.length > 2 ? `; ${failedFiles.length - 2} more` : ""}.` : ""}`,
      failedFiles.length > 0,
    );
    return;
  }

  setStatus(
    `Added ${newTileIds.length} image${newTileIds.length === 1 ? "" : "s"}. ${optimizationMessage}`.trim(),
    false,
  );
}

function setFailedFiles(files) {
  state.failedFiles = files;
  renderMeta();
}

async function retryFailedFiles() {
  if (state.upload.active || !state.failedFiles.length) return;
  const files = state.failedFiles;
  setFailedFiles([]);
  await enqueueUpload(() => processIncomingFiles(files, { isRetry: true }));
}

function cycleGrid(direction = 1) {
  recordHistory("grid", "grid");
  state.gridIndex = (state.gridIndex + direction + gridPresets.length) % gridPresets.length;
  state.pendingRefresh = true;
  saveSettings();
  clampTilesToGrid();
  render();
  const { cols, rows } = getGrid();
  setStatus(`Grid ${cols} × ${rows}.${state.tiles.length ? " Press arrange to apply." : ""}`, false);
}

function cycleToneMode() {
  const currentIndex = toneModes.indexOf(state.controls.tone);
  setToneMode(toneModes[(currentIndex + 1) % toneModes.length]);
}

function setToneMode(mode) {
  if (!toneModes.includes(mode) || mode === state.controls.tone) {
    return;
  }
  state.controls.tone = mode;
  state.pendingRefresh = true;
  saveSettings();
  render();
  setStatus(`Tone grouping ${state.controls.tone}. Press arrange to apply.`, false);
}

function refreshComposition() {
  if (!state.tiles.length) {
    return;
  }

  const targetIds = state.tiles
    .filter((tile) => !tile.locked && !tile.isAnchor)
    .map((tile) => tile.id);

  if (!targetIds.length) {
    state.pendingRefresh = false;
    render();
    setStatus("All images are locked or pinned, so there is nothing to arrange.", true);
    return;
  }

  recordHistory("arrange");

  layoutTiles(targetIds);
  normalizeLayerOrder();
  state.pendingRefresh = false;
  render();
  setStatus("Arranged.", false);
}

function scatter() {
  if (!state.tiles.length) {
    return;
  }

  const targetIds = state.tiles
    .filter((tile) => !tile.locked && !tile.isAnchor)
    .map((tile) => tile.id);

  layoutTiles(targetIds);
  normalizeLayerOrder();
  state.pendingRefresh = false;
  render();
}

function mutate() {
  const candidates = state.tiles.filter((tile) => !tile.locked && !tile.isAnchor);
  if (!candidates.length) {
    return;
  }

  recordHistory("nudge");

  const { cols, rows } = getGrid();
  const overlap = state.controls.overlap / 100;
  const variation = state.controls.variation / 100;
  const toneStrength = getToneStrength();
  const toneClusters = toneStrength ? createToneClusters(cols, rows, state.controls.density / 100) : [];
  const touches = clamp(1, Math.round(candidates.length * (0.16 + variation * 0.16)), candidates.length);
  const picked = sample(candidates, touches);

  for (const tile of picked) {
    tile.x = clamp(-tile.width + 1, tile.x + randomInt(-2, 2), cols - 1);
    tile.y = clamp(-tile.height + 1, tile.y + randomInt(-2, 2), rows - 1);
    tile.width = clamp(1, tile.width + randomInt(-1, 1), cols);
    tile.height = clamp(1, tile.height + randomInt(-1, 1), rows);
    if (Math.random() < 0.28 + overlap * 0.2) {
      tile.zIndex += randomInt(-2, 2);
    }
    if (toneStrength) {
      const target = getToneClusterForTile(tile, toneClusters);
      tile.x = clamp(
        -tile.width + 1,
        Math.round(lerp(tile.x, target.x - tile.width / 2, toneStrength * 0.22)),
        cols - 1,
      );
      tile.y = clamp(
        -tile.height + 1,
        Math.round(lerp(tile.y, target.y - tile.height / 2, toneStrength * 0.14)),
        rows - 1,
      );
    }
  }

  normalizeLayerOrder();
  state.pendingRefresh = false;
  render();
  setStatus(`Nudged ${picked.length} image${picked.length === 1 ? "" : "s"}.`, false);
}

// ---- Layout -------------------------------------------------------------------------------
// The composition is laid out on the classic preset grid (e.g. 12 × 9) whatever the field's
// shape, then mapped onto the square display grid. That keeps the original density and the
// elongated tiles on tall/wide fields, while dragging still snaps to square cells.
// Several candidate layouts are made and the one closest to the "air" target is kept.
function layoutTiles(targetIds) {
  const ids = new Set(targetIds);
  if (!state.tiles.some((tile) => ids.has(tile.id))) {
    render();
    return;
  }

  const original = snapshotTiles();
  const targetEmpty = getTargetEmptiness();
  let best = null;
  for (let attempt = 0; attempt < layoutAttempts; attempt += 1) {
    restoreTiles(original);
    layoutOnClassicGrid(ids);
    const score = Math.abs(measureEmptyShare() - targetEmpty);
    if (!best || score < best.score) {
      best = { score, tiles: snapshotTiles() };
    }
  }
  restoreTiles(best.tiles);
}

// "air" 0..100 → share of the field left empty, from 5% (packed) to 60% (sparse).
function getTargetEmptiness() {
  return lerp(0.05, 0.6, state.controls.air / 100);
}

function getClassicGrid() {
  const preset = gridPresets[state.gridIndex] || gridPresets[0];
  return { cols: preset.cols, rows: preset.rows };
}

function snapshotTiles() {
  return state.tiles.map(({ id, x, y, width, height, zIndex, movedManually, resizedManually }) => ({
    id,
    x,
    y,
    width,
    height,
    zIndex,
    movedManually,
    resizedManually,
  }));
}

function restoreTiles(snapshot) {
  const byId = new Map(snapshot.map((entry) => [entry.id, entry]));
  state.tiles.forEach((tile) => {
    const saved = byId.get(tile.id);
    if (saved) Object.assign(tile, saved);
  });
}

function layoutOnClassicGrid(ids) {
  const real = getGrid();
  const classic = getClassicGrid();
  const rowScale = real.rows / classic.rows;
  const realBefore = new Map(state.tiles.map((tile) => [tile.id, { y: tile.y, height: tile.height }]));

  // Express every tile in classic rows so placement around anchors/locked tiles stays correct.
  state.tiles.forEach((tile) => {
    tile.y /= rowScale;
    tile.height /= rowScale;
  });
  const classicBefore = new Map(state.tiles.map((tile) => [tile.id, { ...tile }]));

  layoutGridOverride = classic;
  try {
    layoutTilesOnClassic(ids);
  } finally {
    layoutGridOverride = null;
  }

  state.tiles.forEach((tile) => {
    const before = classicBefore.get(tile.id);
    const untouched =
      tile.x === before.x && tile.y === before.y && tile.width === before.width && tile.height === before.height;
    if (untouched) {
      Object.assign(tile, realBefore.get(tile.id));
      return;
    }
    tile.height = clamp(1, Math.round(tile.height * rowScale), real.rows);
    tile.y = clamp(-tile.height + 1, Math.round(tile.y * rowScale), real.rows - 1);
  });
}

function measureEmptyShare() {
  const { cols, rows } = getGrid();
  const perCell = 4;
  const width = cols * perCell;
  const height = rows * perCell;
  const covered = new Uint8Array(width * height);
  for (const tile of state.tiles) {
    const top = Math.max(0, Math.round(tile.y * perCell));
    const bottom = Math.min(height, Math.round((tile.y + tile.height) * perCell));
    const left = Math.max(0, Math.round(tile.x * perCell));
    const right = Math.min(width, Math.round((tile.x + tile.width) * perCell));
    for (let y = top; y < bottom; y += 1) {
      covered.fill(1, y * width + left, y * width + Math.max(left, right));
    }
  }
  let filled = 0;
  for (const cell of covered) filled += cell;
  return 1 - filled / covered.length;
}

function layoutTilesOnClassic(ids) {
  const targets = state.tiles.filter((tile) => ids.has(tile.id));
  if (!targets.length) {
    return;
  }

  const { cols, rows } = getGrid();
  const density = state.controls.density / 100;
  const overlap = state.controls.overlap / 100;
  const variation = state.controls.variation / 100;
  const layoutGuide = getLayoutGuide(cols, rows);
  const toneStrength = getToneStrength();
  const anchor = state.tiles.find((tile) => tile.isAnchor) || null;
  const freeClusters = createClusters(cols, rows, density);
  const toneClusters = toneStrength ? createToneClusters(cols, rows, density) : [];
  let zBase = 1;
  const zStep = Math.max(1, Math.round(lerp(4, 1, overlap)));
  const zJitter = Math.max(2, Math.round(lerp(2, 7, overlap)));

  const sortedTargets = toneStrength
    ? [...targets].sort((left, right) => getTileToneValue(left) - getTileToneValue(right))
    : targets;

  for (const tile of sortedTargets) {
    const dims = pickTileSize(cols, rows, density, variation, false, layoutGuide);
    tile.width = dims.width;
    tile.height = dims.height;

    const pos = anchor
      ? placeAroundAnchor(tile, anchor, cols, rows, overlap, density, toneStrength, layoutGuide)
      : placeInFreeMode(
          tile,
          freeClusters,
          toneClusters,
          cols,
          rows,
          overlap,
          density,
          toneStrength,
          layoutGuide,
        );

    tile.x = pos.x;
    tile.y = pos.y;
    tile.zIndex = zBase + randomInt(-zJitter, zJitter);
    tile.movedManually = false;
    tile.resizedManually = false;
    zBase += zStep;
  }

  // The anchor stays exactly where it was pinned (as the inspector promises); the rest is
  // arranged around it. Previously an untouched anchor was re-placed at random on every update.
  if (anchor && !anchor.locked) {
    anchor.zIndex = Math.max(...state.tiles.map((tile) => tile.zIndex), 0) - 1;
  }
}

function pickTileSize(cols, rows, density, variation, isAnchor, layoutGuide = getLayoutGuide(cols, rows)) {
  // Air also nudges tile size (neutral at the middle) so packed and sparse targets are reachable.
  const air = state.controls.air / 100;
  const airScale = air <= 0.5 ? lerp(1.2, 1, air * 2) : lerp(1, 0.5, (air - 0.5) * 2);
  const areaScale = lerp(0.66, 1.42, density) * airScale;
  const minWidth = layoutGuide.compactViewport ? Math.min(cols, Math.max(2, layoutGuide.minTileCols)) : 1;
  const minHeight = layoutGuide.compactViewport ? Math.min(rows, Math.max(2, layoutGuide.minTileRows)) : 1;

  if (isAnchor) {
    const width = clamp(
      Math.max(4, minWidth),
      Math.round(lerp(cols * 0.34, cols * 0.58, Math.max(variation, 0.55)) * areaScale),
      Math.max(4, cols - 2),
    );
    const height = clamp(
      Math.max(3, minHeight),
      Math.round(lerp(rows * 0.32, rows * 0.54, Math.max(variation, 0.45)) * areaScale),
      Math.max(3, rows - 2),
    );
    return { width, height };
  }

  const mode = Math.random();
  let width;
  let height;

  if (mode < 0.22 + variation * 0.14) {
    width = randomInt(minWidth, Math.max(minWidth, variation > 0.5 ? 2 : 3));
    height = randomInt(Math.max(3, Math.round(rows * 0.28)), Math.max(4, Math.round(rows * 0.88)));
  } else if (mode < 0.44 + variation * 0.1) {
    width = randomInt(Math.max(3, Math.round(cols * 0.28)), Math.max(4, Math.round(cols * 0.88)));
    height = randomInt(minHeight, Math.max(minHeight, variation > 0.5 ? 2 : 3));
  } else if (mode < 0.64) {
    width = randomInt(Math.max(2, minWidth), Math.max(Math.max(2, minWidth), variation > 0.55 ? 5 : 4));
    height = randomInt(Math.max(2, minHeight), Math.max(Math.max(2, minHeight), variation > 0.55 ? 5 : 4));
  } else if (mode < 0.87) {
    width = randomInt(Math.max(3, minWidth), Math.min(7, cols - 1));
    height = randomInt(Math.max(3, minHeight), Math.min(7, rows - 1));
  } else {
    width = randomInt(Math.max(4, Math.round(cols * 0.22)), Math.max(5, Math.round(cols * 0.62)));
    height = randomInt(Math.max(3, Math.round(rows * 0.22)), Math.max(4, Math.round(rows * 0.62)));
  }

  width = clamp(minWidth, Math.round(width * areaScale), cols);
  height = clamp(minHeight, Math.round(height * areaScale), rows);

  if (variation < 0.28) {
    width = clamp(Math.max(2, minWidth), Math.round(lerp(width, 4, 0.45)), cols);
    height = clamp(Math.max(2, minHeight), Math.round(lerp(height, 4, 0.45)), rows);
  }

  return { width, height };
}

function createClusters(cols, rows, density) {
  const count = clamp(2, Math.round(1 + density * 5), 6);
  return Array.from({ length: count }, () => ({
    x: randomFloat(cols * 0.12, cols * 0.88),
    y: randomFloat(rows * 0.12, rows * 0.88),
  }));
}

function createToneClusters(cols, rows, density) {
  const xStops = [0.16, 0.38, 0.64, 0.84];
  const yBase = [0.24, 0.7, 0.36, 0.78];
  return xStops.map((stop, index) => ({
    x: cols * stop + randomFloat(-cols * 0.04, cols * 0.04),
    y:
      rows * yBase[index] +
      randomFloat(-rows * 0.06, rows * 0.06) * lerp(1.1, 0.9, density),
  }));
}

function clampLayoutPosition(tile, x, y, cols, rows, layoutGuide = getLayoutGuide(cols, rows)) {
  const minVisibleCols = Math.min(tile.width, layoutGuide.minVisibleCols);
  const minVisibleRows = Math.min(tile.height, layoutGuide.minVisibleRows);
  return {
    x: clamp(minVisibleCols - tile.width, x, cols - minVisibleCols),
    y: clamp(minVisibleRows - tile.height, y, rows - minVisibleRows),
  };
}

function placeInFreeMode(
  tile,
  clusters,
  toneClusters,
  cols,
  rows,
  overlap,
  density,
  toneStrength,
  layoutGuide = getLayoutGuide(cols, rows),
) {
  const useToneCluster =
    toneStrength > 0 && toneClusters.length && Math.random() < 0.55 + toneStrength * 0.3;
  const cluster = useToneCluster
    ? getToneClusterForTile(tile, toneClusters)
    : clusters[randomInt(0, clusters.length - 1)];
  const spreadFactor = useToneCluster ? lerp(1.1, 0.58, toneStrength) : 1;
  const contrastFactor = 1 + getTileToneContrast(tile) * 0.45;
  const spreadX =
    lerp(cols * 0.94, cols * 0.12, overlap) * lerp(1.2, 0.62, density) * spreadFactor * contrastFactor;
  const spreadY =
    lerp(rows * 0.92, rows * 0.14, overlap) * lerp(1.18, 0.66, density) * spreadFactor;
  const x = Math.round(cluster.x - tile.width / 2 + randomFloat(-spreadX, spreadX));
  const y = Math.round(cluster.y - tile.height / 2 + randomFloat(-spreadY, spreadY));
  return clampLayoutPosition(tile, x, y, cols, rows, layoutGuide);
}

function placeAroundAnchor(
  tile,
  anchor,
  cols,
  rows,
  overlap,
  density,
  toneStrength = 0,
  layoutGuide = getLayoutGuide(cols, rows),
) {
  const anchorCenterX = anchor.x + anchor.width / 2;
  const anchorCenterY = anchor.y + anchor.height / 2;
  const local = Math.random() < 0.74;
  const toneValue = getTileToneValue(tile);
  const toneBias = toneStrength ? (toneValue - 0.5) * 2 : 0;
  const offsetX = local
    ? randomFloat(
        -(anchor.width * 0.84 + cols * (0.36 - overlap * 0.22)),
        anchor.width * 0.92 + cols * (0.26 - overlap * 0.12),
      )
    : randomFloat(-cols * 0.52, cols * 0.52);
  const offsetY = local
    ? randomFloat(
        -(anchor.height * 0.82 + rows * (0.3 - overlap * 0.14)),
        anchor.height * 0.94 + rows * (0.28 - overlap * 0.1),
      )
    : randomFloat(-rows * 0.45, rows * 0.45);

  const x = Math.round(
    anchorCenterX +
      offsetX +
      toneBias * (cols * 0.16 + anchor.width * 0.24) * toneStrength -
      tile.width / 2,
  );
  const y = Math.round(
    anchorCenterY +
      offsetY +
      (toneValue < 0.33 ? -1 : toneValue > 0.66 ? 1 : 0) * rows * 0.05 * toneStrength -
      tile.height / 2 +
      randomFloat(-rows * 0.08, rows * 0.08) * (1 - density * 0.25),
  );

  return clampLayoutPosition(tile, x, y, cols, rows, layoutGuide);
}

function resetControls() {
  Object.assign(state.controls, defaultControls);
  syncControlsFromState();
  saveSettings();
  if (state.tiles.length) {
    state.pendingRefresh = true;
  }
  render();
  setStatus(
    state.tiles.length
      ? "Sliders reset to the middle. Press arrange to apply."
      : "Sliders reset to the middle.",
    false,
  );
}

function describeControlLevel(value) {
  if (value < 34) {
    return "low";
  }
  if (value < 67) {
    return "mid";
  }
  return "high";
}

function normalizeLayerOrder() {
  state.tiles
    .sort((a, b) => a.zIndex - b.zIndex)
    .forEach((tile, index) => {
      tile.zIndex = index + 1;
    });
}

function render() {
  renderWorkspaceClasses();
  renderMeta();
  renderTilesOnly();
  renderSelectionOverlay();
  renderInspector();
  renderLayerStrip();
}

function renderWorkspaceClasses() {
  renderNextStep();
  // Tile-related hints and the tile inspector only make sense once there are photos.
  document.body.classList.toggle("has-photos", state.tiles.length > 0);
  elements.workspace.classList.toggle("is-active-crop", state.cropMode);
  elements.workspace.classList.toggle("is-drop-target", state.isDropTarget);
  elements.workspace.classList.toggle("is-loading", state.upload.active);
  elements.workspace.classList.toggle("is-waiting", state.upload.waitingForPicker && !state.upload.active);
  elements.workspaceNote.classList.toggle("is-crop", state.cropMode);
  elements.dropOverlay.classList.toggle(
    "is-hidden",
    state.upload.active || (state.tiles.length > 0 && !state.isDropTarget),
  );
  renderUploadOverlay();
  elements.workspaceNote.textContent = state.cropMode
    ? "Cropping: drag the image to reframe it. Scroll or press + − to zoom. Esc to finish."
    : "Click an image to select it. Double-click to crop.";
}

function renderDropOverlayText() {
  const title = elements.dropOverlay.querySelector(".drop-title");
  const meta = elements.dropOverlay.querySelector(".drop-meta");
  if (window.matchMedia("(pointer: coarse)").matches) {
    // On phones the system photo picker stays open for a while after ✓ while it hands the files
    // over; the site cannot draw over it, so say so before the picker opens.
    title.textContent = "tap to choose images";
    meta.textContent = "after you tap ✓, the phone needs a few seconds to hand them over";
    return;
  }
  title.textContent = "drop images here";
  meta.textContent = state.tiles.length ? "drop more images or click to browse" : "or click to browse";
}

function setStatus(message, isError = false) {
  elements.statusNote.textContent = message;
  elements.statusNote.classList.toggle("is-error", isError);
}

function renderMeta() {
  const grid = getGrid();
  const ratio = state.canvas.width / state.canvas.height;
  elements.workspace.style.setProperty("--workspace-ratio", String(ratio));
  elements.workspace.style.backgroundSize = `calc(100% / ${grid.cols}) calc(100% / ${grid.rows})`;
  elements.gridLabel.textContent = `${grid.cols} × ${grid.rows}`;
  elements.toneLabel.textContent = state.controls.tone;
  elements.canvasLabel.textContent = `${state.canvas.width} × ${state.canvas.height}`;
  elements.photoCount.textContent = String(state.tiles.length);
  elements.layerCount.textContent = String(state.tiles.length);
  elements.anchorLabel.textContent = state.anchorId ? getTile(state.anchorId)?.label || "none" : "none";
  renderDropOverlayText();

  const actionsDisabled = state.upload.active || state.tiles.length === 0;
  elements.uploadButton.setAttribute("aria-disabled", String(state.upload.active));
  elements.gridButton.disabled = state.upload.active;
  elements.toneButton.disabled = state.upload.active;
  elements.canvasWidthInput.disabled = state.upload.active;
  elements.canvasHeightInput.disabled = state.upload.active;
  elements.applyCanvasSizeButton.disabled = state.upload.active;
  elements.dropOverlay.setAttribute("aria-disabled", String(state.upload.active));
  elements.updateButton.disabled = actionsDisabled;
  elements.mutateButton.disabled = actionsDisabled;
  elements.exportButton.disabled = actionsDisabled;
  elements.clearButton.disabled = actionsDisabled;
  if (elements.retryButton) {
    elements.retryButton.hidden = state.upload.active || state.failedFiles.length === 0;
    elements.retryButton.textContent = `retry ${state.failedFiles.length} image${state.failedFiles.length === 1 ? "" : "s"}`;
  }
  renderHistoryButtons();
  elements.updateButton.textContent = "arrange";
  renderNextStep();
}

// The accent colour marks exactly one control: the step the user should take next.
function getNextStep() {
  if (state.upload.active || state.cropMode) return null;
  if (state.tiles.length === 0) return "upload";
  if (state.pendingRefresh) return "update";
  return "export";
}

function renderNextStep() {
  const nextStep = getNextStep();
  elements.uploadButton.classList.toggle("cta", nextStep === "upload");
  elements.updateButton.classList.toggle("cta", nextStep === "update");
  elements.exportButton.classList.toggle("cta", nextStep === "export");
}

// Rebuilding a container drops keyboard focus to <body>. Put it back on the control that had it
// (matched by `keyAttr`), so keyboard users stay where they were after every action.
function rebuildKeepingFocus(container, keyAttr, rebuild) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.getAttribute(keyAttr) : null;
  rebuild();
  if (key === null) return;
  container.querySelector(`[${keyAttr}="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function renderLayerStrip() {
  rebuildKeepingFocus(elements.layerList, "data-tile-id", renderLayerStripContent);
}

function renderLayerStripContent() {
  const sorted = [...state.tiles].sort((left, right) => right.zIndex - left.zIndex);
  elements.layerList.innerHTML = "";
  elements.layerEmpty.hidden = sorted.length > 0;

  if (!sorted.length) {
    return;
  }

  const fragment = document.createDocumentFragment();
  sorted.forEach((tile, index) => {
    const asset = getAsset(tile.assetId);
    if (!asset) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "layer-card";
    button.dataset.tileId = String(tile.id);
    button.title = `Select ${tile.label}`;
    button.draggable = true;
    button.classList.toggle("is-selected", tile.id === state.selectedId);
    button.setAttribute("aria-pressed", String(tile.id === state.selectedId));

    const grip = document.createElement("span");
    grip.className = "layer-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.textContent = "||";

    const thumbWrap = document.createElement("span");
    thumbWrap.className = "layer-thumb-wrap";

    const thumb = document.createElement("img");
    thumb.className = "layer-thumb";
    thumb.src = asset.url;
    thumb.alt = asset.name;
    thumb.loading = "lazy";
    thumbWrap.appendChild(thumb);

    const copy = document.createElement("span");
    copy.className = "layer-copy";

    const titleRow = document.createElement("span");
    titleRow.className = "layer-title-row";

    const title = document.createElement("span");
    title.className = "layer-title";
    title.textContent = tile.label;

    const level = document.createElement("span");
    level.className = "layer-level";
    level.textContent = index === 0 ? "top" : String(index + 1);

    titleRow.append(title, level);

    const meta = document.createElement("span");
    meta.className = "layer-meta";
    meta.textContent = `${tile.width} × ${tile.height} cells`;

    const flags = document.createElement("span");
    flags.className = "layer-flags";
    flags.textContent = [tile.isAnchor ? "anchor" : "", tile.locked ? "locked" : ""]
      .filter(Boolean)
      .join(" / ");
    flags.hidden = !flags.textContent;

    copy.append(titleRow, meta, flags);
    button.append(grip, thumbWrap, copy);
    button.addEventListener("click", () => {
      if (performance.now() < state.layerDrag.suppressClickUntil) {
        return;
      }
      setSelectedTile(tile.id);
    });
    button.addEventListener("dragstart", (event) => handleLayerDragStart(tile.id, event));
    button.addEventListener("dragover", (event) => handleLayerDragOver(tile.id, event));
    button.addEventListener("drop", (event) => handleLayerDrop(tile.id, event));
    button.addEventListener("dragend", handleLayerDragEnd);
    fragment.appendChild(button);
  });

  elements.layerList.appendChild(fragment);
  refreshLayerDragState();
}

function handleLayerDragStart(tileId, event) {
  state.layerDrag.sourceId = tileId;
  state.layerDrag.targetId = null;
  state.layerDrag.placement = "before";
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(tileId));
  }
  refreshLayerDragState();
}

function handleLayerDragOver(tileId, event) {
  if (!state.layerDrag.sourceId || state.layerDrag.sourceId === tileId) {
    return;
  }
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  if (state.layerDrag.targetId !== tileId || state.layerDrag.placement !== placement) {
    state.layerDrag.targetId = tileId;
    state.layerDrag.placement = placement;
    refreshLayerDragState();
  }
}

function handleLayerDrop(tileId, event) {
  if (!state.layerDrag.sourceId) {
    return;
  }
  event.preventDefault();
  const sourceId = state.layerDrag.sourceId;
  const { placement } = state.layerDrag;
  finishLayerDrag();
  if (sourceId === tileId) {
    setSelectedTile(sourceId);
    return;
  }
  recordHistory("layer order");
  reorderLayerStack(sourceId, tileId, placement);
  setSelectedTile(sourceId);
  setStatus(`Layer order updated. ${getTile(sourceId)?.label || "Selected image"} moved in the stack.`, false);
}

function handleLayerDragEnd() {
  finishLayerDrag();
}

function finishLayerDrag() {
  state.layerDrag.sourceId = null;
  state.layerDrag.targetId = null;
  state.layerDrag.placement = "before";
  state.layerDrag.suppressClickUntil = performance.now() + 180;
  refreshLayerDragState();
}

function reorderLayerStack(sourceId, targetId, placement) {
  const ordered = [...state.tiles].sort((left, right) => right.zIndex - left.zIndex);
  const sourceIndex = ordered.findIndex((tile) => tile.id === sourceId);
  const targetIndex = ordered.findIndex((tile) => tile.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return;
  }

  const [sourceTile] = ordered.splice(sourceIndex, 1);
  const insertionIndex = ordered.findIndex((tile) => tile.id === targetId) + (placement === "after" ? 1 : 0);
  ordered.splice(insertionIndex, 0, sourceTile);

  ordered.forEach((tile, index) => {
    tile.zIndex = ordered.length - index;
  });

  render();
}

function refreshLayerDragState() {
  Array.from(elements.layerList.querySelectorAll(".layer-card")).forEach((card) => {
    const tileId = Number(card.dataset.tileId);
    card.classList.toggle("is-dragging", tileId === state.layerDrag.sourceId);
    card.classList.toggle(
      "is-drop-before",
      tileId === state.layerDrag.targetId && state.layerDrag.placement === "before",
    );
    card.classList.toggle(
      "is-drop-after",
      tileId === state.layerDrag.targetId && state.layerDrag.placement === "after",
    );
  });
}

function renderTilesOnly() {
  const metrics = getMetrics();
  const sorted = [...state.tiles].sort((a, b) => a.zIndex - b.zIndex);
  const existingIds = new Set(sorted.map((tile) => String(tile.id)));

  Array.from(elements.workspace.querySelectorAll(".tile")).forEach((node) => {
    if (!existingIds.has(node.dataset.tileId)) {
      node.remove();
    }
  });

  for (const tile of sorted) {
    renderTile(tile, metrics);
  }
}

function renderSelectionOverlay(metrics = getMetrics()) {
  const tile = getSelectedTile();
  let overlay = elements.workspace.querySelector(".selection-overlay");

  if (!tile) {
    overlay?.remove();
    return;
  }

  if (!overlay) {
    overlay = buildSelectionOverlay();
    elements.workspace.appendChild(overlay);
  }

  overlay.hidden = false;
  overlay.style.left = `${tile.x * metrics.colPx}px`;
  overlay.style.top = `${tile.y * metrics.rowPx}px`;
  overlay.style.width = `${tile.width * metrics.colPx}px`;
  overlay.style.height = `${tile.height * metrics.rowPx}px`;
  overlay.classList.toggle("is-locked", tile.locked);
  overlay.classList.toggle("is-crop", state.cropMode && tile.id === state.selectedId);
}

function renderTile(tile, metrics = getMetrics()) {
  const asset = getAsset(tile.assetId);
  if (!asset) {
    return;
  }

  let tileEl = elements.workspace.querySelector(`[data-tile-id="${tile.id}"]`);
  if (!tileEl) {
    tileEl = buildTileElement(tile, asset);
    elements.workspace.appendChild(tileEl);
  }

  tileEl.style.left = `${tile.x * metrics.colPx}px`;
  tileEl.style.top = `${tile.y * metrics.rowPx}px`;
  tileEl.style.width = `${tile.width * metrics.colPx}px`;
  tileEl.style.height = `${tile.height * metrics.rowPx}px`;
  tileEl.style.zIndex = String(tile.zIndex);
  tileEl.classList.toggle("is-selected", tile.id === state.selectedId);
  tileEl.classList.toggle("is-locked", tile.locked);
  tileEl.classList.toggle("is-crop", state.cropMode && tile.id === state.selectedId);

  const img = tileEl.querySelector("img");
  if (img.getAttribute("src") !== asset.url) {
    img.src = asset.url;
  }
  img.alt = asset.name;
  // Position the photo in pixels with the same math as drawTileToCanvas, so cropX/cropY pan
  // along both axes (including the extra room cropScale adds) and the screen matches export.
  const tileWidthPx = tile.width * metrics.colPx;
  const tileHeightPx = tile.height * metrics.rowPx;
  const cover = getCoverFrame(asset, tileWidthPx, tileHeightPx, tile.cropScale);
  img.style.width = `${cover.drawWidth}px`;
  img.style.height = `${cover.drawHeight}px`;
  img.style.left = `${-(cover.drawWidth - tileWidthPx) * tile.cropX}px`;
  img.style.top = `${-(cover.drawHeight - tileHeightPx) * tile.cropY}px`;

  const badge = tileEl.querySelector(".tile-badge");
  const badgeParts = [];
  if (tile.isAnchor) {
    badgeParts.push("anchor");
  }
  if (tile.locked) {
    badgeParts.push("locked");
  }
  badge.textContent = badgeParts.join(" / ");
  badge.hidden = badgeParts.length === 0;

  const cropNote = tileEl.querySelector(".tile-crop-note");
  cropNote.hidden = !(state.cropMode && tile.id === state.selectedId);
}

function buildSelectionOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "selection-overlay";

  const xHandle = document.createElement("div");
  xHandle.className = "tile-handle";
  xHandle.dataset.handle = "x";

  const yHandle = document.createElement("div");
  yHandle.className = "tile-handle";
  yHandle.dataset.handle = "y";

  const xyHandle = document.createElement("div");
  xyHandle.className = "tile-handle";
  xyHandle.dataset.handle = "xy";

  overlay.append(xHandle, yHandle, xyHandle);
  return overlay;
}

function buildTileElement(tile, asset) {
  const tileEl = document.createElement("article");
  tileEl.className = "tile";
  tileEl.dataset.tileId = String(tile.id);

  const image = document.createElement("img");
  image.src = asset.url;
  image.alt = asset.name;

  const badge = document.createElement("div");
  badge.className = "tile-badge";

  const cropNote = document.createElement("div");
  cropNote.className = "tile-crop-note";
  cropNote.textContent = "crop";
  cropNote.hidden = true;

  const xHandle = document.createElement("div");
  xHandle.className = "tile-handle";
  xHandle.dataset.handle = "x";

  const yHandle = document.createElement("div");
  yHandle.className = "tile-handle";
  yHandle.dataset.handle = "y";

  const xyHandle = document.createElement("div");
  xyHandle.className = "tile-handle";
  xyHandle.dataset.handle = "xy";

  tileEl.append(image, badge, cropNote, xHandle, yHandle, xyHandle);
  return tileEl;
}

function renderInspector() {
  rebuildKeepingFocus(elements.inspector, "data-action", renderInspectorContent);
}

function renderInspectorContent() {
  const tile = getSelectedTile();

  if (!tile) {
    elements.inspector.innerHTML = `
      <p class="empty-note">select an image</p>
      <p class="empty-note inspector-note">Click an image to move, resize, crop, replace, lock or pin it as anchor. An anchor stays in place while the rest is arranged around it.</p>
    `;
    return;
  }

  const cropAction = state.cropMode ? "done" : "crop";
  const anchorAction = tile.isAnchor ? "release anchor" : "pin anchor";
  const lockAction = tile.locked ? "unlock" : "lock";
  const anchorCopy = tile.isAnchor
    ? "This image stays in place when you press arrange."
    : "Pin as anchor to keep this image in place while the rest is arranged around it.";

  elements.inspector.innerHTML = `
    <div class="inspector-state">
      <div class="inspector-title">
        <span>selected</span>
        <span>${tile.label}</span>
      </div>
      <div class="inspector-row">
        <span>size</span>
        <span>${tile.width} × ${tile.height}</span>
      </div>
      <div class="inspector-row">
        <span>crop</span>
        <span>${Math.round(tile.cropScale * 100)}%</span>
      </div>
    </div>
    <div class="inspector-actions">
      <button class="text-action inspector-action" data-action="replace" type="button">replace</button>
      <button class="text-action inspector-action${state.cropMode ? " cta" : ""}" data-action="crop" type="button">${cropAction}</button>
      <button class="text-action inspector-action" data-action="lock" type="button">${lockAction}</button>
      <button class="text-action inspector-action" data-action="anchor" type="button">${anchorAction}</button>
      <button class="text-action inspector-action" data-action="delete" type="button">delete</button>
    </div>
    <p class="empty-note inspector-note">${anchorCopy}</p>
    <p class="empty-note inspector-note">${
      state.cropMode
        ? "Keys: arrows pan the image, + and − zoom, Esc finishes."
        : "Keys: arrows move, Shift + arrows resize, [ and ] move a layer down or up. Or drag images in the layers list."
    }</p>
  `;

  elements.inspector.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runInspectorAction(button.dataset.action));
  });
}

function runInspectorAction(action) {
  if (state.upload.active) return;
  const tile = getSelectedTile();
  if (!tile) {
    return;
  }

  if (action === "replace") {
    state.replaceTileId = tile.id;
    elements.replaceInput.click();
    return;
  }

  if (action === "crop") {
    if (!state.cropMode) {
      ensureCropFreedom(tile);
    }
    state.cropMode = !state.cropMode;
    renderTilesOnly();
    renderWorkspaceClasses();
    renderInspector();
    return;
  }

  if (action === "lock") {
    recordHistory(tile.locked ? "unlock" : "lock");
    tile.locked = !tile.locked;
    if (tile.locked) {
      state.cropMode = false;
    }
    render();
    return;
  }

  if (action === "anchor") {
    recordHistory(tile.isAnchor ? "release anchor" : "pin anchor");
    if (tile.isAnchor) {
      tile.isAnchor = false;
      state.anchorId = null;
      setStatus(`${tile.label} released. Arrange will move it again.`, false);
    } else {
      state.tiles.forEach((item) => {
        item.isAnchor = false;
      });
      tile.isAnchor = true;
      state.anchorId = tile.id;
      setStatus(
        `${tile.label} pinned as anchor. Arrange keeps it in place and places the other images around it.`,
        false,
      );
    }
    render();
    return;
  }

  if (action === "delete") {
    recordHistory("delete");
    state.tiles = state.tiles.filter((item) => item.id !== tile.id);
    releaseUnusedAsset(tile.assetId);
    if (state.anchorId === tile.id) {
      state.anchorId = null;
    }
    setSelectedTile(null);
    normalizeLayerOrder();
    updateUploadLabel();
    render();
    setStatus(`${tile.label} deleted.`, false);
    // The delete button is gone; keep keyboard users in the layers list (or on the upload button).
    (elements.layerList.querySelector(".layer-card") || elements.uploadButton).focus({ preventScroll: true });
  }
}

// ---- Undo / redo ---------------------------------------------------------------------------
// Every action that changes the composition first records a snapshot of it. Images that only
// history still refers to are kept alive (not revoked) so undo can bring them back.

function captureComposition(label) {
  return {
    label,
    tiles: state.tiles.map((tile) => ({ ...tile })),
    assets: state.assets.slice(),
    anchorId: state.anchorId,
    selectedId: state.selectedId,
    gridIndex: state.gridIndex,
    canvas: { ...state.canvas },
  };
}

// mergeKey: consecutive records with the same key within a second count as one step
// (holding an arrow key, scrolling to zoom).
function recordHistory(label, mergeKey = null) {
  const now = performance.now();
  if (mergeKey && undoHistory.mergeKey === mergeKey && now - undoHistory.mergedAt < 1000) {
    undoHistory.mergedAt = now;
    return;
  }
  undoHistory.mergeKey = mergeKey;
  undoHistory.mergedAt = now;
  pushHistorySnapshot(captureComposition(label));
}

function pushHistorySnapshot(snapshot) {
  undoHistory.undo.push(snapshot);
  if (undoHistory.undo.length > historyLimit) {
    undoHistory.undo.shift();
  }
  undoHistory.redo = [];
  pruneAssets();
  renderHistoryButtons();
}

function applyComposition(snapshot) {
  state.tiles = snapshot.tiles.map((tile) => ({ ...tile }));
  state.assets = snapshot.assets.slice();
  state.anchorId = snapshot.anchorId;
  state.selectedId = state.tiles.some((tile) => tile.id === snapshot.selectedId) ? snapshot.selectedId : null;
  state.gridIndex = snapshot.gridIndex;
  state.canvas = { ...snapshot.canvas };
  state.cropMode = false;
  state.interaction = null;
  undoHistory.mergeKey = null;
  syncCanvasInputs();
  saveSettings();
  updateUploadLabel();
  render();
}

function undo() {
  if (state.upload.active || !undoHistory.undo.length) return;
  const snapshot = undoHistory.undo.pop();
  undoHistory.redo.push(captureComposition(snapshot.label));
  applyComposition(snapshot);
  renderHistoryButtons();
  setStatus(`Undid ${snapshot.label}.`, false);
}

function redo() {
  if (state.upload.active || !undoHistory.redo.length) return;
  const snapshot = undoHistory.redo.pop();
  undoHistory.undo.push(captureComposition(snapshot.label));
  applyComposition(snapshot);
  renderHistoryButtons();
  setStatus(`Redid ${snapshot.label}.`, false);
}

function renderHistoryButtons() {
  const lastUndo = undoHistory.undo[undoHistory.undo.length - 1];
  const lastRedo = undoHistory.redo[undoHistory.redo.length - 1];
  elements.undoButton.hidden = state.upload.active || !lastUndo;
  elements.redoButton.hidden = state.upload.active || !lastRedo;
  elements.undoButton.title = lastUndo ? `Undo ${lastUndo.label} (⌘Z / Ctrl+Z)` : "";
  elements.redoButton.title = lastRedo ? `Redo ${lastRedo.label} (⇧⌘Z / Ctrl+Y)` : "";
}

function registerAsset(asset) {
  knownAssets.set(asset.id, asset);
}

// Revoke image URLs that neither the composition nor any undo/redo step uses any more.
function pruneAssets() {
  const inUse = new Set(state.assets.map((asset) => asset.id));
  for (const snapshot of [...undoHistory.undo, ...undoHistory.redo]) {
    snapshot.assets.forEach((asset) => inUse.add(asset.id));
  }
  for (const [id, asset] of knownAssets) {
    if (!inUse.has(id)) {
      URL.revokeObjectURL(asset.url);
      knownAssets.delete(id);
    }
  }
}

function releaseUnusedAsset(assetId) {
  if (state.tiles.some((tile) => tile.assetId === assetId)) return;
  state.assets = state.assets.filter((item) => item.id !== assetId);
  pruneAssets();
}

function updateUploadLabel() {
  elements.uploadButton.textContent = "add images";
}

function clearComposition() {
  if (!state.tiles.length && !state.assets.length) {
    return;
  }

  recordHistory("clear all");
  state.assets = [];
  state.tiles = [];
  state.selectedId = null;
  state.anchorId = null;
  state.cropMode = false;
  state.replaceTileId = null;
  state.pendingRefresh = false;
  state.interaction = null;
  state.failedFiles = [];
  pruneAssets();
  updateUploadLabel();
  render();
  setStatus("Cleared. Undo brings everything back.", false);
}

function containsImageFiles(dataTransfer) {
  if (!dataTransfer) {
    return false;
  }

  if (dataTransfer.files?.length) {
    return true;
  }

  return Array.from(dataTransfer.items || []).some(
    (item) => item.kind === "file" && (item.type.startsWith("image/") || !item.type),
  );
}

function clearDropTarget() {
  state.dragDepth = 0;
  state.isDropTarget = false;
  renderWorkspaceClasses();
}

let uploadTicker = 0;

function renderUploadOverlay() {
  const upload = state.upload;
  const visible = upload.active || upload.waitingForPicker;
  elements.loadingOverlay.setAttribute("aria-hidden", String(!visible));
  elements.loadingBar.hidden = !upload.active;
  // Only offer to stop while there is still something after the current image.
  elements.stopUploadButton.hidden = !upload.active || upload.currentIndex >= upload.total - 1;
  elements.stopUploadButton.disabled = upload.stopRequested;
  elements.stopUploadButton.textContent = upload.stopRequested ? "stopping…" : "stop after this image";

  if (!upload.active) {
    elements.loadingTitle.textContent = upload.waitingForPicker ? "waiting for images" : "preparing images";
    elements.loadingMeta.textContent = upload.waitingForPicker
      ? "your device is handing them over, this can take a moment"
      : "working…";
    elements.loadingHint.hidden = true;
    return;
  }

  const total = Math.max(1, upload.total);
  const ready = Math.min(upload.processed, total);
  elements.loadingTitle.textContent = `${ready} of ${total} done`;
  elements.loadingBarDone.style.width = `${(ready / total) * 100}%`;
  elements.loadingBarCurrent.style.left = `${(ready / total) * 100}%`;
  elements.loadingBarCurrent.style.width = upload.currentFile ? `${100 / total}%` : "0";

  const seconds = upload.fileStartedAt ? Math.floor((Date.now() - upload.fileStartedAt) / 1000) : 0;
  const fileLabel = upload.currentFile
    ? `now: ${formatLoadingFileLabel(upload.currentFile)}${seconds >= 2 ? ` · ${seconds}s` : ""}`
    : "working…";
  elements.loadingMeta.textContent = fileLabel;
  elements.loadingHint.hidden = seconds < 6;
  elements.loadingHint.textContent = "Large photos, especially HEIC from iPhone, can take up to half a minute each.";
}

function addLoadingThumb(asset) {
  const thumb = document.createElement("img");
  thumb.src = asset.url;
  thumb.alt = "";
  thumb.decoding = "async";
  elements.loadingThumbs.append(thumb);
  // Keep the strip to two short rows; the newest images matter most.
  while (elements.loadingThumbs.children.length > 16) elements.loadingThumbs.firstElementChild.remove();
  state.upload.processed = Math.min(state.upload.processed + 1, state.upload.total);
  renderUploadOverlay();
}

function beginUploadProgress(total) {
  state.upload.active = true;
  state.upload.total = total;
  state.upload.processed = 0;
  state.upload.currentFile = "";
  state.upload.currentIndex = 0;
  state.upload.fileStartedAt = 0;
  state.upload.stopRequested = false;
  state.upload.waitingForPicker = false;
  elements.loadingThumbs.replaceChildren();
  render();
  setStatus(`Preparing ${total} image${total === 1 ? "" : "s"}…`, false);
}

function updateUploadProgress(index, total, fileName) {
  state.upload.active = true;
  state.upload.total = total;
  state.upload.processed = index;
  state.upload.currentFile = fileName;
  state.upload.currentIndex = index;
  state.upload.fileStartedAt = Date.now();
  // Restart the ticker for each image so its seconds count from that image's start.
  window.clearInterval(uploadTicker);
  uploadTicker = window.setInterval(renderUploadOverlay, 500);
  renderWorkspaceClasses();
  renderMeta();
  if (!state.upload.stopRequested) {
    setStatus(`Preparing image ${index + 1} of ${total}…`, false);
  }
}

function endUploadProgress() {
  window.clearInterval(uploadTicker);
  state.upload.active = false;
  state.upload.total = 0;
  state.upload.processed = 0;
  state.upload.currentFile = "";
  state.upload.fileStartedAt = 0;
  state.upload.stopRequested = false;
  elements.loadingThumbs.replaceChildren();
  render();
}

function formatLoadingFileLabel(fileName) {
  if (!fileName) {
    return "working…";
  }

  return truncateMiddle(fileName, 32);
}

function truncateMiddle(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  const edge = Math.max(6, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

function nextFrame() {
  // requestAnimationFrame is paused while the page is hidden (e.g. the iOS photo picker is still
  // closing, or the user switched apps) and throttled in some in-app browsers; never wait on it alone.
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    window.setTimeout(finish, 100);
  });
}

function getToneStrength() {
  if (state.controls.tone === "strong") {
    return 0.9;
  }
  if (state.controls.tone === "soft") {
    return 0.52;
  }
  return 0;
}

function getTileToneValue(tile) {
  return getAsset(tile.assetId)?.tone?.brightness ?? 0.5;
}

function getTileToneContrast(tile) {
  return getAsset(tile.assetId)?.tone?.contrast ?? 0.2;
}

function getToneClusterForTile(tile, toneClusters) {
  if (!toneClusters.length) {
    return { x: 0, y: 0 };
  }

  const toneValue = clamp(0, getTileToneValue(tile) + randomFloat(-0.08, 0.08), 1);
  const rawIndex = Math.round(toneValue * (toneClusters.length - 1));
  const index = clamp(0, rawIndex, toneClusters.length - 1);
  return toneClusters[index];
}

async function exportComposition() {
  const canvas = document.createElement("canvas");
  canvas.width = state.canvas.width;
  canvas.height = state.canvas.height;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = getExportBackgroundColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const grid = getGrid();
  const metrics = {
    ...grid,
    rect: { width: canvas.width, height: canvas.height },
    colPx: canvas.width / grid.cols,
    rowPx: canvas.height / grid.rows,
  };
  const sorted = [...state.tiles].sort((a, b) => a.zIndex - b.zIndex);

  for (const tile of sorted) {
    const asset = getAsset(tile.assetId);
    if (!asset) {
      continue;
    }
    if (!asset.img.complete) {
      await asset.img.decode().catch(() => null);
    }
    drawTileToCanvas(ctx, tile, asset, metrics);
  }

  const link = document.createElement("a");
  link.download = `intersection-map-${state.canvas.width}x${state.canvas.height}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function drawTileToCanvas(ctx, tile, asset, metrics) {
  const x = tile.x * metrics.colPx;
  const y = tile.y * metrics.rowPx;
  const width = tile.width * metrics.colPx;
  const height = tile.height * metrics.rowPx;
  const cover = getCoverFrame(asset, width, height, tile.cropScale);
  const offsetX = (cover.drawWidth - width) * tile.cropX;
  const offsetY = (cover.drawHeight - height) * tile.cropY;
  const drawX = x - offsetX;
  const drawY = y - offsetY;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.drawImage(asset.img, drawX, drawY, cover.drawWidth, cover.drawHeight);
  ctx.restore();
}

function getCoverFrame(asset, tileWidthPx, tileHeightPx, cropScale) {
  const widthRatio = tileWidthPx / asset.width;
  const heightRatio = tileHeightPx / asset.height;
  const baseScale = Math.max(widthRatio, heightRatio) * cropScale;
  return {
    drawWidth: asset.width * baseScale,
    drawHeight: asset.height * baseScale,
  };
}

function ensureCropFreedom(tile) {
  const asset = getAsset(tile.assetId);
  if (!asset) {
    return;
  }

  const metrics = getMetrics();
  const tileWidthPx = tile.width * metrics.colPx;
  const tileHeightPx = tile.height * metrics.rowPx;
  const minOverflowX = Math.min(36, tileWidthPx * 0.1);
  const minOverflowY = Math.min(36, tileHeightPx * 0.1);

  let nextScale = tile.cropScale;
  let cover = getCoverFrame(asset, tileWidthPx, tileHeightPx, nextScale);
  let safety = 0;

  while (
    safety < 20 &&
    nextScale < 2.6 &&
    (cover.drawWidth - tileWidthPx < minOverflowX || cover.drawHeight - tileHeightPx < minOverflowY)
  ) {
    nextScale = round(Math.min(2.6, nextScale + 0.08), 2);
    cover = getCoverFrame(asset, tileWidthPx, tileHeightPx, nextScale);
    safety += 1;
  }

  tile.cropScale = nextScale;
}

function clamp(min, value, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value, precision = 3) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function snapToStep(value, step) {
  return round(Math.round(value / step) * step, 2);
}

function getExportBackgroundColor() {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--paper-alt")
    .trim();
  return value || "#f0f0f0";
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function sample(list, count) {
  const pool = [...list];
  const result = [];
  while (pool.length && result.length < count) {
    result.push(pool.splice(randomInt(0, pool.length - 1), 1)[0]);
  }
  return result;
}
