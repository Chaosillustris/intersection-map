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
const toneModes = ["off", "soft", "strong"];

const gridPresets = [
  { cols: 12, rows: 9 },
  { cols: 14, rows: 10 },
  { cols: 16, rows: 10 },
  { cols: 10, rows: 8 },
];

const elements = {
  workspace: document.getElementById("workspace"),
  emptyState: document.getElementById("emptyState"),
  dropOverlay: document.getElementById("dropOverlay"),
  loadingOverlay: document.getElementById("loadingOverlay"),
  loadingTitle: document.getElementById("loadingTitle"),
  loadingMeta: document.getElementById("loadingMeta"),
  photoCount: document.getElementById("photoCount"),
  compositionMode: document.getElementById("compositionMode"),
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
  scatterButton: document.getElementById("scatterButton"),
  mutateButton: document.getElementById("mutateButton"),
  exportButton: document.getElementById("exportButton"),
  statusNote: document.getElementById("statusNote"),
  densityRange: document.getElementById("densityRange"),
  overlapRange: document.getElementById("overlapRange"),
  variationRange: document.getElementById("variationRange"),
  inspector: document.getElementById("inspector"),
  workspaceNote: document.getElementById("workspaceNote"),
  layerCount: document.getElementById("layerCount"),
  layerList: document.getElementById("layerList"),
  layerEmpty: document.getElementById("layerEmpty"),
  fileInput: document.getElementById("fileInput"),
  replaceInput: document.getElementById("replaceInput"),
};

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
  },
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
    density: savedSettings.density ?? 58,
    overlap: savedSettings.overlap ?? 68,
    variation: savedSettings.variation ?? 62,
    tone: toneModes.includes(savedSettings.tone) ? savedSettings.tone : "soft",
  },
};

syncControlsFromState();
syncCanvasInputs();
updateUploadLabel();
render();
bindEvents();

function bindEvents() {
  elements.uploadButton.addEventListener("click", () => elements.fileInput.click());
  elements.dropOverlay.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", handleUpload);
  elements.replaceInput.addEventListener("change", handleReplace);
  elements.updateButton.addEventListener("click", refreshComposition);
  elements.scatterButton.addEventListener("click", () => scatter());
  elements.mutateButton.addEventListener("click", () => mutate());
  elements.exportButton.addEventListener("click", () => exportComposition());
  elements.gridButton.addEventListener("click", cycleGrid);
  elements.toneButton.addEventListener("click", cycleToneMode);
  elements.applyCanvasSizeButton.addEventListener("click", applyCanvasSize);
  elements.densityRange.addEventListener("input", handleControlInput);
  elements.overlapRange.addEventListener("input", handleControlInput);
  elements.variationRange.addEventListener("input", handleControlInput);
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
      tone: state.controls.tone,
      gridIndex: state.gridIndex,
      canvasWidth: state.canvas.width,
      canvasHeight: state.canvas.height,
    }),
  );
}

function syncControlsFromState() {
  elements.densityRange.value = state.controls.density;
  elements.overlapRange.value = state.controls.overlap;
  elements.variationRange.value = state.controls.variation;
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

  state.canvas = nextSize;
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
  state.pendingRefresh = true;
  saveSettings();
  renderMeta();
  setStatus(
    `Density ${describeControlLevel(state.controls.density)}, overlap ${describeControlLevel(state.controls.overlap)}, variation ${describeControlLevel(state.controls.variation)}. Press update to reflow the composition.`,
    false,
  );
}

async function handleUpload(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  await processIncomingFiles(files);
}

async function handleReplace(event) {
  const file = event.target.files?.[0];
  const tile = getSelectedTile();
  if (!file || !tile || state.replaceTileId !== tile.id) {
    event.target.value = "";
    return;
  }

  const asset = await createAsset(file);
  state.assets.push(asset);
  tile.assetId = asset.id;
  event.target.value = "";
  state.replaceTileId = null;
  setStatus(
    asset.optimized
      ? `Replaced ${tile.label}. Optimized for smoother editing.`
      : `Replaced ${tile.label}.`,
    false,
  );
  render();
}

async function createAsset(file) {
  const prepared = await prepareAssetSource(file);
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

async function prepareAssetSource(file) {
  const source = await loadImageSource(file, file.name);
  const shouldOptimize = shouldOptimizeImage(file, source.width, source.height);

  if (!shouldOptimize) {
    return {
      ...source,
      blob: file,
      optimized: false,
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
      blob: file,
      optimized: false,
      resized: false,
    };
  }

  if (!resized && optimizedBlob.size >= file.size * 0.98) {
    return {
      ...source,
      blob: file,
      optimized: false,
      resized: false,
    };
  }

  URL.revokeObjectURL(source.url);
  const optimizedSource = await loadImageSource(optimizedBlob, file.name);
  return {
    ...optimizedSource,
    blob: optimizedBlob,
    optimized: true,
    resized,
  };
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
  canvas.width = targetSize.width;
  canvas.height = targetSize.height;

  const preserveAlpha = preservesAlpha(file);
  const context = canvas.getContext("2d", { alpha: preserveAlpha });
  if (!context) {
    return null;
  }

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

  canvas.width = 1;
  canvas.height = 1;
  return blob;
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
    img.decoding = "async";
    img.onload = () =>
      resolve({
        url,
        img,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load ${label}`));
    };
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

function getGrid() {
  return gridPresets[state.gridIndex] || gridPresets[0];
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
  };
}

function beginCropDrag(tile, event) {
  ensureCropFreedom(tile);
  state.interaction = {
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
  state.interaction = null;
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
  tile.cropScale = clamp(1, round(tile.cropScale + delta, 2), 2.6);
  renderTilesOnly();
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    state.cropMode = false;
    clearDropTarget();
    renderWorkspaceClasses();
    renderInspector();
  }
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
  await processIncomingFiles(files);
}

async function processIncomingFiles(selectedFiles) {
  const files = selectedFiles.filter(looksLikeImageFile);
  const skippedByType = selectedFiles.length - files.length;

  if (!files.length) {
    setStatus("Drop or choose image files to add them to the grid.", true);
    return;
  }

  const isInitialUpload = state.tiles.length === 0;
  const newTileIds = [];
  const failedFiles = [];
  const optimizedAssets = [];

  beginUploadProgress(files.length);
  await nextFrame();
  try {
    for (const [index, file] of files.entries()) {
      updateUploadProgress(index, files.length, file.name);
      await nextFrame();
      try {
        const asset = await createAsset(file);
        state.assets.push(asset);
        const tile = createTile(asset.id);
        state.tiles.push(tile);
        newTileIds.push(tile.id);
        if (asset.optimized) {
          optimizedAssets.push(asset);
        }
      } catch {
        failedFiles.push(file.name);
      }
    }
  } finally {
    endUploadProgress();
  }

  if (!newTileIds.length) {
    setStatus("The selected files could not be opened by this browser.", true);
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
  const skippedCount = skippedByType + failedFiles.length;
  if (skippedCount) {
    setStatus(
      `Added ${newTileIds.length} photo${newTileIds.length === 1 ? "" : "s"}. ${optimizationMessage}Skipped ${skippedCount} unsupported file${skippedCount === 1 ? "" : "s"}.`,
      false,
    );
    return;
  }

  setStatus(
    `Added ${newTileIds.length} photo${newTileIds.length === 1 ? "" : "s"}. ${optimizationMessage}`.trim(),
    false,
  );
}

function cycleGrid() {
  state.gridIndex = (state.gridIndex + 1) % gridPresets.length;
  state.pendingRefresh = true;
  saveSettings();
  state.tiles.forEach((tile) => {
    tile.x = clamp(-tile.width + 1, tile.x, getGrid().cols - 1);
    tile.y = clamp(-tile.height + 1, tile.y, getGrid().rows - 1);
    tile.width = clamp(1, tile.width, getGrid().cols);
    tile.height = clamp(1, tile.height, getGrid().rows);
  });
  render();
}

function cycleToneMode() {
  const currentIndex = toneModes.indexOf(state.controls.tone);
  state.controls.tone = toneModes[(currentIndex + 1) % toneModes.length];
  state.pendingRefresh = true;
  saveSettings();
  render();
  setStatus(`Tone grouping ${state.controls.tone}. Press update to reflow the layout.`, false);
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
    setStatus("No unlocked photos are available to update.", true);
    return;
  }

  layoutTiles(targetIds);
  normalizeLayerOrder();
  state.pendingRefresh = false;
  render();
  setStatus("Composition updated for the current grid and controls.", false);
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
}

function layoutTiles(targetIds) {
  const ids = new Set(targetIds);
  const targets = state.tiles.filter((tile) => ids.has(tile.id));
  if (!targets.length) {
    render();
    return;
  }

  const { cols, rows } = getGrid();
  const density = state.controls.density / 100;
  const overlap = state.controls.overlap / 100;
  const variation = state.controls.variation / 100;
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
    const dims = pickTileSize(cols, rows, density, variation, false);
    tile.width = dims.width;
    tile.height = dims.height;

    const pos = anchor
      ? placeAroundAnchor(tile, anchor, cols, rows, overlap, density, toneStrength)
      : placeInFreeMode(tile, freeClusters, toneClusters, cols, rows, overlap, density, toneStrength);

    tile.x = pos.x;
    tile.y = pos.y;
    tile.zIndex = zBase + randomInt(-zJitter, zJitter);
    tile.movedManually = false;
    tile.resizedManually = false;
    zBase += zStep;
  }

  if (anchor && !anchor.locked) {
    if (!anchor.movedManually && !anchor.resizedManually) {
      const dims = pickTileSize(cols, rows, density, variation, true);
      anchor.width = dims.width;
      anchor.height = dims.height;
      const placement = placeAnchor(cols, rows, anchor.width, anchor.height);
      anchor.x = placement.x;
      anchor.y = placement.y;
    }
    anchor.zIndex = Math.max(...state.tiles.map((tile) => tile.zIndex), 0) - 1;
  }
}

function pickTileSize(cols, rows, density, variation, isAnchor) {
  const areaScale = lerp(0.66, 1.42, density);

  if (isAnchor) {
    const width = clamp(
      4,
      Math.round(lerp(cols * 0.34, cols * 0.58, Math.max(variation, 0.55)) * areaScale),
      Math.max(4, cols - 2),
    );
    const height = clamp(
      3,
      Math.round(lerp(rows * 0.32, rows * 0.54, Math.max(variation, 0.45)) * areaScale),
      Math.max(3, rows - 2),
    );
    return { width, height };
  }

  const mode = Math.random();
  let width;
  let height;

  if (mode < 0.22 + variation * 0.14) {
    width = randomInt(1, variation > 0.5 ? 2 : 3);
    height = randomInt(Math.max(3, Math.round(rows * 0.28)), Math.max(4, Math.round(rows * 0.88)));
  } else if (mode < 0.44 + variation * 0.1) {
    width = randomInt(Math.max(3, Math.round(cols * 0.28)), Math.max(4, Math.round(cols * 0.88)));
    height = randomInt(1, variation > 0.5 ? 2 : 3);
  } else if (mode < 0.64) {
    width = randomInt(2, variation > 0.55 ? 5 : 4);
    height = randomInt(2, variation > 0.55 ? 5 : 4);
  } else if (mode < 0.87) {
    width = randomInt(3, Math.min(7, cols - 1));
    height = randomInt(3, Math.min(7, rows - 1));
  } else {
    width = randomInt(Math.max(4, Math.round(cols * 0.22)), Math.max(5, Math.round(cols * 0.62)));
    height = randomInt(Math.max(3, Math.round(rows * 0.22)), Math.max(4, Math.round(rows * 0.62)));
  }

  width = clamp(1, Math.round(width * areaScale), cols);
  height = clamp(1, Math.round(height * areaScale), rows);

  if (variation < 0.28) {
    width = clamp(2, Math.round(lerp(width, 4, 0.45)), cols);
    height = clamp(2, Math.round(lerp(height, 4, 0.45)), rows);
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

function placeInFreeMode(tile, clusters, toneClusters, cols, rows, overlap, density, toneStrength) {
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
  return {
    x: clamp(-tile.width + 1, x, cols - 1),
    y: clamp(-tile.height + 1, y, rows - 1),
  };
}

function placeAnchor(cols, rows, width, height) {
  const x = Math.round(randomFloat(cols * 0.08, cols * 0.64 - width * 0.4));
  const y = Math.round(randomFloat(rows * 0.06, rows * 0.62 - height * 0.35));
  return {
    x: clamp(-width + 1, x, cols - 1),
    y: clamp(-height + 1, y, rows - 1),
  };
}

function placeAroundAnchor(tile, anchor, cols, rows, overlap, density, toneStrength = 0) {
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

  return {
    x: clamp(-tile.width + 1, x, cols - 1),
    y: clamp(-tile.height + 1, y, rows - 1),
  };
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
  elements.workspace.classList.toggle("is-active-crop", state.cropMode);
  elements.workspace.classList.toggle("is-drop-target", state.isDropTarget);
  elements.workspace.classList.toggle("is-loading", state.upload.active);
  elements.workspaceNote.classList.toggle("is-crop", state.cropMode);
  elements.dropOverlay.classList.toggle(
    "is-hidden",
    state.upload.active || (state.tiles.length > 0 && !state.isDropTarget),
  );
  elements.loadingOverlay.setAttribute("aria-hidden", String(!state.upload.active));
  elements.loadingTitle.textContent = state.upload.active
    ? `preparing photos ${Math.min(state.upload.processed + 1, state.upload.total)} / ${state.upload.total}`
    : "preparing photos";
  elements.loadingMeta.textContent = state.upload.active
    ? formatLoadingFileLabel(state.upload.currentFile)
    : "working…";
  elements.workspaceNote.textContent = state.cropMode
    ? "Crop mode: drag inside the tile to reposition. Use the wheel to zoom. Press Esc to exit."
    : "Drag photos onto the grid. Select a tile to pin it as anchor, or double-click it to crop.";
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
  elements.compositionMode.textContent = state.anchorId ? "anchor" : "free";
  elements.anchorLabel.textContent = state.anchorId ? getTile(state.anchorId)?.label || "none" : "none";
  elements.emptyState.hidden = state.tiles.length > 0;
  elements.dropOverlay.querySelector(".drop-meta").textContent = state.tiles.length
    ? "drop more photos or click to browse"
    : "or click to browse";

  const actionsDisabled = state.upload.active || state.tiles.length === 0;
  elements.uploadButton.disabled = state.upload.active;
  elements.gridButton.disabled = state.upload.active;
  elements.toneButton.disabled = state.upload.active;
  elements.canvasWidthInput.disabled = state.upload.active;
  elements.canvasHeightInput.disabled = state.upload.active;
  elements.applyCanvasSizeButton.disabled = state.upload.active;
  elements.dropOverlay.disabled = state.upload.active;
  elements.updateButton.disabled = actionsDisabled;
  elements.scatterButton.disabled = actionsDisabled;
  elements.mutateButton.disabled = actionsDisabled;
  elements.exportButton.disabled = actionsDisabled;
  elements.updateButton.textContent = state.pendingRefresh ? "update *" : "update";
}

function renderLayerStrip() {
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
    level.textContent = index === 0 ? "top" : `z ${tile.zIndex}`;

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
  img.src = asset.url;
  img.alt = asset.name;
  img.style.objectPosition = `${tile.cropX * 100}% ${tile.cropY * 100}%`;
  img.style.transform = `scale(${tile.cropScale})`;

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
  const tile = getSelectedTile();

  if (!tile) {
    elements.inspector.innerHTML = `
      <p class="empty-note">select a tile</p>
      <p class="empty-note inspector-note">Move, resize, crop, replace, lock, or pin one image as anchor. Anchor keeps that photo fixed while update or scatter arranges the rest around it.</p>
    `;
    return;
  }

  const cropAction = state.cropMode ? "done" : "crop";
  const anchorAction = tile.isAnchor ? "release anchor" : "pin anchor";
  const lockAction = tile.locked ? "unlock" : "lock";
  const roleLabel = tile.isAnchor ? "anchored tile" : "free tile";
  const anchorCopy = tile.isAnchor
    ? "This tile stays fixed when you press update or scatter."
    : "Pin this tile as anchor to keep it fixed while the rest rearranges around it.";

  elements.inspector.innerHTML = `
    <div class="inspector-state">
      <div class="inspector-title">
        <span>selected</span>
        <span>${tile.label}</span>
      </div>
      <div class="inspector-row">
        <span>role</span>
        <span>${roleLabel}</span>
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
      <button class="text-action inspector-action" data-action="crop" type="button">${cropAction}</button>
      <button class="text-action inspector-action" data-action="lock" type="button">${lockAction}</button>
      <button class="text-action inspector-action" data-action="anchor" type="button">${anchorAction}</button>
      <button class="text-action inspector-action" data-action="delete" type="button">delete</button>
    </div>
    <p class="empty-note inspector-note">${anchorCopy}</p>
    <p class="empty-note inspector-note">Reorder layer depth from the layers panel by dragging cards up or down.</p>
  `;

  elements.inspector.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runInspectorAction(button.dataset.action));
  });
}

function runInspectorAction(action) {
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
    renderWorkspaceClasses();
    renderInspector();
    return;
  }

  if (action === "lock") {
    tile.locked = !tile.locked;
    if (tile.locked) {
      state.cropMode = false;
    }
    render();
    return;
  }

  if (action === "anchor") {
    if (tile.isAnchor) {
      tile.isAnchor = false;
      state.anchorId = null;
      setStatus(`${tile.label} released. Scatter and update will move it normally again.`, false);
    } else {
      state.tiles.forEach((item) => {
        item.isAnchor = false;
      });
      tile.isAnchor = true;
      state.anchorId = tile.id;
      setStatus(
        `${tile.label} pinned as anchor. Update and scatter will keep it in place and arrange other photos around it.`,
        false,
      );
    }
    render();
    return;
  }

  if (action === "delete") {
    state.tiles = state.tiles.filter((item) => item.id !== tile.id);
    if (state.anchorId === tile.id) {
      state.anchorId = null;
    }
    setSelectedTile(null);
    normalizeLayerOrder();
    updateUploadLabel();
    render();
  }
}

function updateUploadLabel() {
  elements.uploadButton.textContent = state.tiles.length ? "add photos" : "add photos";
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

function beginUploadProgress(total) {
  state.upload.active = true;
  state.upload.total = total;
  state.upload.processed = 0;
  state.upload.currentFile = "";
  render();
  setStatus(`Preparing ${total} photo${total === 1 ? "" : "s"}…`, false);
}

function updateUploadProgress(index, total, fileName) {
  state.upload.active = true;
  state.upload.total = total;
  state.upload.processed = index;
  state.upload.currentFile = fileName;
  renderWorkspaceClasses();
  renderMeta();
  setStatus(
    `Loading ${index + 1} / ${total}… ${formatLoadingFileLabel(fileName)}`,
    false,
  );
}

function endUploadProgress() {
  state.upload.active = false;
  state.upload.total = 0;
  state.upload.processed = 0;
  state.upload.currentFile = "";
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
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
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
  return value || "#edf0f2";
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
