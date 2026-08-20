export default function Home() {
  return (
    <>
      <div className="app">
        <aside className="rail">
          <div className="rail-block masthead">
            <p className="kicker">intersection map / 01</p>
            <p className="version-tag">
              version <span id="appVersionLabel">1.0.2</span> <span id="appBuildLabel"></span>
            </p>
          </div>

          <div className="rail-block meta">
            <div className="meta-row">
              <span>photos</span>
              <span id="photoCount">0</span>
            </div>
            <div className="meta-row">
              <span>composition</span>
              <span id="compositionMode">free</span>
            </div>
            <div className="meta-row">
              <span>anchor</span>
              <span id="anchorLabel">none</span>
            </div>
            <button className="meta-row action-row" id="gridButton" type="button">
              <span>grid</span>
              <span id="gridLabel">12 × 9</span>
            </button>
            <button className="meta-row action-row" id="toneButton" type="button">
              <span>tone</span>
              <span id="toneLabel">soft</span>
            </button>
          </div>

          <div className="rail-block controls">
            <label className="control-row" htmlFor="densityRange">
              <span>density</span>
              <input id="densityRange" type="range" min="0" max="100" defaultValue="58" />
            </label>
            <label className="control-row" htmlFor="overlapRange">
              <span>overlap</span>
              <input id="overlapRange" type="range" min="0" max="100" defaultValue="68" />
            </label>
            <label className="control-row" htmlFor="variationRange">
              <span>variation</span>
              <input id="variationRange" type="range" min="0" max="100" defaultValue="62" />
            </label>
          </div>

          <div className="rail-block format-block">
            <div className="inspector-title">
              <span>field</span>
              <span id="canvasLabel">1600 × 1200</span>
            </div>
            <div className="size-grid">
              <label className="size-input" htmlFor="canvasWidthInput">
                <span>width</span>
                <input id="canvasWidthInput" type="number" min="480" max="6000" step="10" inputMode="numeric" />
              </label>
              <label className="size-input" htmlFor="canvasHeightInput">
                <span>height</span>
                <input id="canvasHeightInput" type="number" min="480" max="6000" step="10" inputMode="numeric" />
              </label>
            </div>
            <button className="text-action" id="applyCanvasSizeButton" type="button">
              apply size
            </button>
          </div>

          <div className="rail-block inspector" id="inspector">
            <p className="empty-note">select a tile</p>
          </div>
        </aside>

        <main className="stage">
          <div className="stage-header">
            <div className="stage-heading">
              <p className="stage-kicker">workspace</p>
              <p className="stage-subtitle">drop photographs directly onto the field or add them manually</p>
            </div>
            <div className="stage-actions">
              <label className="text-action upload-trigger" id="uploadButton" htmlFor="fileInput" role="button" tabIndex={0}>
                add photos
              </label>
              <button className="text-action" id="updateButton" type="button">
                update
              </button>
              <button className="text-action" id="scatterButton" type="button">
                scatter
              </button>
              <button className="text-action" id="mutateButton" type="button">
                mutate
              </button>
              <button className="text-action" id="exportButton" type="button">
                export
              </button>
              <button className="text-action" id="clearButton" type="button">
                clear all
              </button>
            </div>
          </div>
          <p className="status-note stage-status" id="statusNote" aria-live="polite"></p>
          <div className="stage-rule"></div>
          <div className="workspace-layout">
            <div className="workspace-frame">
              <div className="workspace" id="workspace">
                <label className="drop-overlay" id="dropOverlay" htmlFor="fileInput" role="button" tabIndex={0}>
                  <span className="drop-title">drop photos here</span>
                  <span className="drop-meta">or click to browse</span>
                </label>
                <div className="loading-overlay" id="loadingOverlay" aria-live="polite" aria-hidden="true">
                  <p className="loading-title" id="loadingTitle">
                    preparing photos
                  </p>
                  <p className="loading-meta" id="loadingMeta">
                    working…
                  </p>
                </div>
                <div className="empty-state" id="emptyState">
                  <p>Drop 10–30 photographs straight onto the grid.</p>
                  <p>Scatter builds an irregular composition from unlocked tiles.</p>
                </div>
              </div>
            </div>
            <aside className="layers-panel">
              <div className="layers-header">
                <p className="stage-kicker">layers</p>
                <p className="layers-count" id="layerCount">
                  0
                </p>
              </div>
              <p className="layers-note">Drag cards here to reorder depth. Click a card to select the photo.</p>
              <div className="layers-list" id="layerList" aria-live="polite"></div>
              <p className="empty-note layers-empty" id="layerEmpty">
                Hidden and overlapping photos will appear here.
              </p>
            </aside>
          </div>
          <div className="stage-footnote" id="workspaceNote">
            Double-click a selected tile to enter crop mode.
          </div>
        </main>
      </div>

      <input id="fileInput" className="visually-hidden-input" type="file" accept="image/*" multiple />
      <input id="replaceInput" className="visually-hidden-input" type="file" accept="image/*" />
      <script src="/version.js" defer></script>
      <script src="/app.js" defer></script>
    </>
  );
}
