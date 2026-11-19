const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const { chromium } = require("playwright");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".ts":
    case ".tsx":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

// Headers from the "/*" block of _headers, so the smoke test runs under the real CSP.
function readGlobalHeaders(rootDir) {
  const headers = {};
  let inGlobal = false;
  for (const line of fs.readFileSync(path.join(rootDir, "_headers"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      inGlobal = line.trim() === "/*";
      continue;
    }
    const separator = line.indexOf(":");
    if (inGlobal && separator > 0) headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  delete headers["Strict-Transport-Security"];
  return headers;
}

function startStaticServer(rootDir) {
  const siteHeaders = readGlobalHeaders(rootDir);
  const server = http.createServer((request, response) => {
    const parsedUrl = new URL(request.url || "/", "http://127.0.0.1");
    const relativePath = decodeURIComponent(parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname);
    const resolvedPath = path.resolve(rootDir, `.${relativePath}`);

    if (!resolvedPath.startsWith(rootDir)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.readFile(resolvedPath, (error, buffer) => {
      if (error) {
        response.writeHead(error.code === "ENOENT" ? 404 : 500);
        response.end(error.code === "ENOENT" ? "Not found" : "Server error");
        return;
      }

      response.writeHead(200, { ...siteHeaders, "Content-Type": getContentType(resolvedPath) });
      response.end(buffer);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

function writeFixture(fileName, base64) {
  const target = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(target, Buffer.from(base64, "base64"));
  return target;
}

async function text(locator) {
  return (await locator.textContent())?.trim() || "";
}

async function assertButtonsShareSingleRow(page, selectors, message) {
  const tops = [];
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox();
    assert(box, `Missing bounding box for ${selector}`);
    tops.push(Math.round(box.y));
  }

  const maxTop = Math.max(...tops);
  const minTop = Math.min(...tops);
  assert(maxTop - minTop <= 4, message);
}

async function assertFileChooserOpens(page, triggerSelector, message) {
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.click(triggerSelector);
  const chooser = await chooserPromise;
  assert(chooser, message);
}

async function assertReadableMobileLayout(page, message) {
  const workspace = await page.locator("#workspace").boundingBox();
  const tileBoxes = await page.locator(".tile").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    }),
  );

  assert(workspace, "Missing workspace bounds");
  assert(tileBoxes.length > 0, "No tiles were rendered for mobile layout check");

  for (const box of tileBoxes) {
    const visibleWidth = Math.max(0, Math.min(box.right, workspace.x + workspace.width) - Math.max(box.left, workspace.x));
    const visibleHeight = Math.max(0, Math.min(box.bottom, workspace.y + workspace.height) - Math.max(box.top, workspace.y));
    assert(visibleWidth >= 32, `${message}: tile is too hidden horizontally`);
    assert(visibleHeight >= 32, `${message}: tile is too hidden vertically`);
    assert(box.width >= 48, `${message}: tile is too narrow for mobile`);
    assert(box.height >= 48, `${message}: tile is too short for mobile`);
  }
}

async function resizeSelectedTile(page) {
  const selectedTile = page.locator(".tile.is-selected");
  const dragVectors = [
    { dx: 120, dy: 120 },
    { dx: 84, dy: 148 },
    { dx: 148, dy: 84 },
  ];
  const handleSelectors = [
    ".selection-overlay [data-handle='xy']",
    ".tile.is-selected [data-handle='xy']",
    ".selection-overlay [data-handle='x']",
    ".selection-overlay [data-handle='y']",
  ];

  for (const handleSelector of handleSelectors) {
    for (const vector of dragVectors) {
      const before = await selectedTile.boundingBox();
      const handleBox = await page.locator(handleSelector).boundingBox();
      if (!before || !handleBox) {
        continue;
      }

      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        handleBox.x + handleBox.width / 2 + vector.dx,
        handleBox.y + handleBox.height / 2 + vector.dy,
        { steps: 12 },
      );
      await page.mouse.up();

      const after = await selectedTile.boundingBox();
      if (
        after &&
        (after.width > before.width + 5 || after.height > before.height + 5)
      ) {
        return true;
      }
    }
  }

  const edgeBefore = await selectedTile.boundingBox();
  if (edgeBefore) {
    await page.mouse.move(edgeBefore.x + edgeBefore.width - 2, edgeBefore.y + edgeBefore.height - 2);
    await page.mouse.down();
    await page.mouse.move(edgeBefore.x + edgeBefore.width + 96, edgeBefore.y + edgeBefore.height + 96, {
      steps: 12,
    });
    await page.mouse.up();
    const edgeAfter = await selectedTile.boundingBox();
    if (
      edgeAfter &&
      (edgeAfter.width > edgeBefore.width + 5 || edgeAfter.height > edgeBefore.height + 5)
    ) {
      return true;
    }
  }

  return false;
}

async function main() {
  const rootDir = path.resolve(__dirname);
  const { server, url } = await startStaticServer(rootDir);
  const imageA = writeFixture(
    "intersection-map-a.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn8j3cAAAAASUVORK5CYII=",
  );
  const imageB = writeFixture(
    "intersection-map-b.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AApMBgU6PvxQAAAAASUVORK5CYII=",
  );
  const heicImage = path.join(rootDir, "tests", "fixtures", "sample.heic");

  const browser = await chromium.launch({ headless: true });
  const cspViolations = [];
  // Uncaught exceptions and unhandled promise rejections on any page fail the run: a broken
  // script can leave the page looking fine (static HTML) while features silently stop working.
  const pageErrors = [];
  const openPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const created = await openPage(...args);
    created.on("pageerror", (error) => {
      pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n    ${error.stack.split("\n").slice(1, 3).join("\n    ")}` : ""}`);
    });
    created.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text());
    });
    return created;
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });

    assert((await page.title()) === "intersection map", "Unexpected page title");

    const buttons = [
      "#uploadButton",
      "#updateButton",
      "#mutateButton",
      "#exportButton",
      "#clearButton",
      "#gridButton",
      "#toneButton",
      "#applyCanvasSizeButton",
    ];

    for (const selector of buttons) {
      assert(await page.locator(selector).count(), `Missing control: ${selector}`);
    }

    await assertButtonsShareSingleRow(
      page,
      ["#uploadButton", "#updateButton", "#mutateButton", "#exportButton", "#clearButton"],
      "Desktop action row wrapped unexpectedly",
    );

    assert(await page.locator("#updateButton").isDisabled(), "Update should start disabled");
    assert(await page.locator("#mutateButton").isDisabled(), "Mutate should start disabled");
    assert(await page.locator("#exportButton").isDisabled(), "Export should start disabled");
    assert(await page.locator("#clearButton").isDisabled(), "Clear all should start disabled");
    assert(
      (await text(page.locator("#appVersionLabel"))).replace(/^v/i, "") === require("./package.json").version,
      "Version label did not render",
    );
    assert(
      (await page.locator("#uploadButton").evaluate((node) => node.tagName)) === "LABEL",
      "Upload trigger should use a label for mobile-safe file picking",
    );
    assert(
      !(await page.locator("#fileInput").evaluate((node) => node.hasAttribute("hidden"))),
      "File input should remain available to its label trigger",
    );
    await assertFileChooserOpens(page, "#uploadButton", "Desktop upload trigger did not open file chooser");
    await assertFileChooserOpens(page, "#dropOverlay", "Desktop drop overlay did not open file chooser");

    await page.locator("#fileInput").setInputFiles([imageA, imageB]);
    await page.waitForFunction(() => document.querySelectorAll(".tile").length === 2);
    await page.waitForFunction(
      () => document.getElementById("photoCount")?.textContent?.trim() === "2",
    );

    assert(!(await page.locator("#updateButton").isDisabled()), "Arrange should enable after upload");
    assert(!(await page.locator("#clearButton").isDisabled()), "Clear all should enable after upload");
    assert((await page.locator(".layer-card").count()) === 2, "Layer strip should list uploaded photos");

    const gridBefore = await text(page.locator("#gridLabel"));
    await page.click("#gridButton");
    const gridAfter = await text(page.locator("#gridLabel"));
    assert(gridBefore !== gridAfter, "Grid button did not cycle");

    const toneBefore = await text(page.locator("#toneLabel"));
    await page.click("#toneButton");
    const toneAfter = await text(page.locator("#toneLabel"));
    assert(toneBefore !== toneAfter, "Tone button did not cycle");

    await page.locator("#densityRange").evaluate((node) => {
      node.value = "41";
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Pending changes make "update" the highlighted next step (the only .cta control).
    assert(
      await page.locator("#updateButton").evaluate((node) => node.classList.contains("cta")),
      "Update indicator did not appear",
    );
    assert((await page.locator(".stage-actions .cta").count()) === 1, "More than one next-step button is highlighted");

    await page.fill("#canvasWidthInput", "1320");
    await page.fill("#canvasHeightInput", "980");
    await page.click("#applyCanvasSizeButton");
    await page.waitForFunction(
      () => document.getElementById("canvasLabel")?.textContent?.trim() === "1320 × 980",
    );

    // Tiles are placed randomly and may hang off the field or sit under others; find a point on
    // some tile that is inside the field and not covered, and click the tile there.
    const clickTarget = await page.evaluate(() => {
      const field = document.getElementById("workspace").getBoundingClientRect();
      const tiles = [...document.querySelectorAll(".tile")];
      for (const [index, tile] of tiles.entries()) {
        const rect = tile.getBoundingClientRect();
        for (let fy = 0.1; fy < 1; fy += 0.2) {
          for (let fx = 0.1; fx < 1; fx += 0.2) {
            const x = rect.left + rect.width * fx;
            const y = rect.top + rect.height * fy;
            const inside = x > field.left + 2 && x < field.right - 2 && y > field.top + 2 && y < field.bottom - 2;
            if (inside && document.elementFromPoint(x, y)?.closest(".tile") === tile) {
              return { index, x: x - rect.left, y: y - rect.top };
            }
          }
        }
      }
      return { index: 0, x: 12, y: 12 };
    });
    const firstTile = page.locator(".tile").nth(clickTarget.index);
    await firstTile.click({ position: { x: clickTarget.x, y: clickTarget.y } });
    await page.waitForFunction(
      () => /selected/i.test(document.getElementById("inspector")?.textContent || ""),
    );
    // Give the pointer checks below a predictable target: a 3 × 3 tile near the top-left, on top.
    await page.evaluate(() => {
      const tile = getSelectedTile();
      Object.assign(tile, { x: 1, y: 1, width: 3, height: 3 });
      tile.zIndex = Math.max(...state.tiles.map((item) => item.zIndex)) + 1;
      normalizeLayerOrder();
      render();
    });
    const selectedTile = page.locator(".tile.is-selected");

    const beforeDrag = await firstTile.boundingBox();
    assert(beforeDrag, "Could not read tile bounding box before drag");
    await page.mouse.move(beforeDrag.x + 16, beforeDrag.y + 16);
    await page.mouse.down();
    await page.mouse.move(beforeDrag.x + 42, beforeDrag.y + 34, { steps: 10 });
    await page.mouse.up();
    const afterDrag = await firstTile.boundingBox();
    assert(afterDrag, "Could not read tile bounding box after drag");
    assert(
      Math.abs(afterDrag.x - beforeDrag.x) > 5 || Math.abs(afterDrag.y - beforeDrag.y) > 5,
      "Tile drag did not move enough",
    );

    let resized = await resizeSelectedTile(page);
    if (!resized) {
      await page.locator(".layer-card").nth(1).click();
      resized = await resizeSelectedTile(page);
    }
    assert(resized, "Tile resize did not change size enough");

    await page.dblclick(".tile", { position: { x: 14, y: 14 } });
    await page.waitForFunction(
      () => /Cropping:/i.test(document.getElementById("workspaceNote")?.textContent || ""),
    );
    await page.waitForFunction(() => {
      const inspector = document.getElementById("inspector")?.textContent || "";
      const match = inspector.match(/crop\s+(\d+)%/i);
      return match ? Number(match[1]) > 100 : false;
    });
    // Compare where the photo actually sits inside the tile, not just the stored crop values.
    const readImageOffset = (node) => {
      const tileRect = node.parentElement.getBoundingClientRect();
      const imageRect = node.getBoundingClientRect();
      return `${Math.round(imageRect.left - tileRect.left)} ${Math.round(imageRect.top - tileRect.top)}`;
    };
    // Lift the tile to the top with "]" so no other tile covers the point we drag from.
    const tileCount = await page.locator(".tile").count();
    for (let step = 0; step < tileCount; step += 1) {
      await page.keyboard.press("]");
    }
    assert(
      await page.evaluate(() => Math.max(...state.tiles.map((tile) => tile.zIndex)) === getSelectedTile().zIndex),
      "] did not bring the selected tile to the top",
    );
    const cropBox = await selectedTile.boundingBox();
    assert(cropBox, "Could not read crop box");
    const dragCrop = async (dx, dy) => {
      await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(cropBox.x + cropBox.width / 2 + dx, cropBox.y + cropBox.height / 2 + dy, {
        steps: 8,
      });
      await page.mouse.up();
    };
    // Two drags in opposite directions: the photo itself must move on both axes, not just the
    // stored crop values (which used to change while the picture stayed put).
    await dragCrop(-12, -12);
    const cropPositionBefore = await selectedTile.locator("img").evaluate(readImageOffset);
    await dragCrop(12, 12);
    const cropPositionAfter = await selectedTile.locator("img").evaluate(readImageOffset);
    const [beforeX, beforeY] = cropPositionBefore.split(" ").map(Number);
    const [afterX, afterY] = cropPositionAfter.split(" ").map(Number);
    assert(
      afterX !== beforeX && afterY !== beforeY,
      `Crop drag did not move the photo on both axes (${cropPositionBefore} -> ${cropPositionAfter})`,
    );
    await page.mouse.wheel(0, -240);
    await page.waitForFunction(
      () => /%/.test(document.getElementById("inspector")?.textContent || ""),
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !/Cropping:/i.test(document.getElementById("workspaceNote")?.textContent || ""),
    );

    await page.click('[data-action="anchor"]');
    await page.waitForFunction(
      () => document.getElementById("anchorLabel")?.textContent?.trim() !== "none",
    );
    assert(
      /pinned as anchor/i.test(await text(page.locator("#statusNote"))),
      "Anchor status message did not appear",
    );

    const anchorBefore = await page.evaluate(() => {
      const tile = state.tiles.find((item) => item.isAnchor);
      // As if pinned without touching it first: the old code re-placed such anchors at random.
      tile.movedManually = false;
      tile.resizedManually = false;
      return `${tile.x},${tile.y},${tile.width},${tile.height}`;
    });
    await page.click("#updateButton");
    await page.waitForFunction(
      () => /Arranged/i.test(document.getElementById("statusNote")?.textContent || ""),
    );
    const anchorAfter = await page.evaluate(() => {
      const tile = state.tiles.find((item) => item.isAnchor);
      return `${tile.x},${tile.y},${tile.width},${tile.height}`;
    });
    assert(anchorAfter === anchorBefore, `Anchor moved on update (${anchorBefore} -> ${anchorAfter})`);

    // Undo / redo of arrange with the keyboard.
    const layoutSignature = () =>
      page.evaluate(() => JSON.stringify(state.tiles.map((tile) => [tile.id, tile.x, tile.y, tile.width, tile.height])));
    const arrangedLayout = await layoutSignature();
    await page.keyboard.press("Control+KeyZ");
    await page.waitForFunction(() => /Undid arrange/i.test(document.getElementById("statusNote")?.textContent || ""));
    await page.keyboard.press("Control+Shift+KeyZ");
    await page.waitForFunction(() => /Redid arrange/i.test(document.getElementById("statusNote")?.textContent || ""));
    assert((await layoutSignature()) === arrangedLayout, "Redo did not restore the arranged layout");

    await page.click('[data-action="replace"]');
    await page.locator("#replaceInput").setInputFiles(imageB);
    await page.waitForFunction(
      () => /Replaced/i.test(document.getElementById("statusNote")?.textContent || ""),
    );

    await page.click('[data-action="lock"]');
    assert(/unlock/i.test(await text(page.locator('[data-action="lock"]'))), "Lock toggle failed");
    assert(
      await page.evaluate(() => document.activeElement?.dataset.action === "lock"),
      "Keyboard focus was lost after an inspector action",
    );

    const topLayerTitleBefore = await text(page.locator(".layer-card .layer-title").first());
    await page.locator(".layer-card").nth(1).click();
    assert(
      await page.locator(".layer-card").nth(1).evaluate((node) => node.classList.contains("is-selected")),
      "Layer click did not select tile",
    );
    const topLayerTitleAfterSelect = await text(page.locator(".layer-card .layer-title").first());
    assert(topLayerTitleAfterSelect === topLayerTitleBefore, "Layer click should not surface tile");
    assert(
      await page.evaluate(() => document.activeElement?.classList.contains("layer-card")),
      "Keyboard focus was lost after selecting a layer card",
    );

    // Keyboard equivalents: arrows move the selected tile, Shift + arrows resize it.
    const tileState = () => page.evaluate(() => {
      const tile = getSelectedTile();
      return { x: tile.x, width: tile.width };
    });
    // The tile locked above may be the one selected now; locked tiles (correctly) ignore arrows.
    if (await page.evaluate(() => getSelectedTile().locked)) {
      await page.click('[data-action="lock"]');
    }
    await page.locator(".layer-card.is-selected").focus();
    const beforeKeys = await tileState();
    await page.keyboard.press("ArrowRight");
    let afterKeys = await tileState();
    if (afterKeys.x === beforeKeys.x) {
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      afterKeys = await tileState();
    }
    assert(afterKeys.x !== beforeKeys.x, "Arrow keys did not move the selected tile");
    await page.keyboard.press("Shift+ArrowLeft");
    const afterResize = await tileState();
    assert(afterResize.width !== afterKeys.width || afterKeys.width === 1, "Shift + arrow did not resize the selected tile");

    // Drop on the upper part of the top card so the placement is "before" it, independent of card height.
    await page.locator(".layer-card").nth(1).dragTo(page.locator(".layer-card").first(), {
      targetPosition: { x: 24, y: 4 },
    });
    await page.waitForFunction(
      () => /Layer order updated/i.test(document.getElementById("statusNote")?.textContent || ""),
    );
    const promotedLayerTitle = await text(page.locator(".layer-card .layer-title").first());
    assert(promotedLayerTitle !== topLayerTitleBefore, "Layer drag did not reorder the stack");

    const downloadPromise = page.waitForEvent("download");
    await page.click("#exportButton");
    const download = await downloadPromise;
    assert(
      /intersection-map-1320x980\.png/i.test(download.suggestedFilename()),
      "Export filename was unexpected",
    );

    await page.click('[data-action="delete"]');
    await page.waitForFunction(() => document.querySelectorAll(".tile").length === 1);

    await page.click("#clearButton");
    await page.waitForFunction(() => document.querySelectorAll(".tile").length === 0);
    await page.waitForFunction(
      () => document.getElementById("photoCount")?.textContent?.trim() === "0",
    );
    assert(await page.locator("#clearButton").isDisabled(), "Clear all should disable after clearing");

    // Clear all can be undone from the status line, and the images still load afterwards.
    assert(await page.locator("#undoButton").isVisible(), "Undo should be offered after clear all");
    await page.click("#undoButton");
    await page.waitForFunction(() => Number(document.getElementById("photoCount")?.textContent) > 0);
    assert(
      await page.evaluate(() =>
        [...document.querySelectorAll(".tile img")].every((img) => img.complete && img.naturalWidth > 0),
      ),
      "Images did not come back after undoing clear all",
    );
    await page.keyboard.press("Control+KeyY");
    await page.waitForFunction(() => document.getElementById("photoCount")?.textContent?.trim() === "0");

    const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobilePage.goto(url, { waitUntil: "domcontentloaded" });
    // On phones the actions may wrap, but every one must be fully on screen.
    const mobileActions = ["#uploadButton", "#updateButton", "#mutateButton", "#exportButton", "#clearButton"];
    const readActionBoxes = async () => {
      const boxes = [];
      for (const selector of mobileActions) {
        const box = await mobilePage.locator(selector).boundingBox();
        assert(box, `Missing bounding box for ${selector}`);
        boxes.push({ x: Math.round(box.x), y: Math.round(box.y), right: Math.round(box.x + box.width) });
      }
      return boxes;
    };
    for (const box of await readActionBoxes()) {
      assert(box.x >= 0 && box.right <= 390, "Mobile action button is cut off the screen");
    }
    await assertFileChooserOpens(
      mobilePage,
      "#uploadButton",
      "Mobile upload trigger did not open file chooser",
    );
    await assertFileChooserOpens(
      mobilePage,
      "#dropOverlay",
      "Mobile drop overlay did not open file chooser",
    );
    await mobilePage.locator("#fileInput").setInputFiles([imageA, imageB, imageA]);
    await mobilePage.waitForFunction(() => document.querySelectorAll(".tile").length === 3);
    assert(
      (await mobilePage.locator("#photoCount").textContent())?.trim() === "3",
      "Mobile upload did not update photo count",
    );
    await assertReadableMobileLayout(
      mobilePage,
      "Mobile upload layout should keep tiles readable inside the field",
    );
    // Moving the highlight between "export" and "arrange" must not move any button.
    // Compare positions relative to the first button, so a page scroll does not count as movement.
    const relativeBoxes = (boxes) => boxes.map((box) => ({ x: box.x - boxes[0].x, y: box.y - boxes[0].y }));
    const positionsWithExportHighlighted = JSON.stringify(relativeBoxes(await readActionBoxes()));
    await mobilePage.locator("#densityRange").evaluate((node) => {
      node.value = "40";
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert(
      await mobilePage.locator("#updateButton").evaluate((node) => node.classList.contains("cta")),
      "Arrange should be highlighted after a setting change on mobile",
    );
    assert(
      JSON.stringify(relativeBoxes(await readActionBoxes())) === positionsWithExportHighlighted,
      "Mobile action buttons moved when the highlight changed",
    );
    await mobilePage.close();

    const uploadPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    uploadPage.on("console", (message) => { if (message.type() === "error") console.log("browser console:", message.text()); });
    await uploadPage.goto(url, { waitUntil: "domcontentloaded" });

    // Network failure while downloading the HEIC decoder: automatic retries, then a clear error,
    // closed overlay and a visible "retry failed" action.
    let decoderRequests = 0;
    await uploadPage.route("**/vendor/heic-to.iife.js*", (route) => { decoderRequests += 1; return route.abort(); });
    await uploadPage.locator("#fileInput").setInputFiles(heicImage);
    await uploadPage.waitForFunction(() => document.getElementById("statusNote")?.textContent?.includes("HEIC decoder could not load"), null, { timeout: 20000 });
    assert(decoderRequests >= 2, `HEIC decoder download was not retried automatically (${decoderRequests} request)`);
    assert(await uploadPage.locator("#loadingOverlay").getAttribute("aria-hidden") === "true", "Failed HEIC load left loading overlay open");
    assert(await uploadPage.locator("#retryButton").isVisible(), "Retry action should appear after a network failure");
    assert(!(await uploadPage.locator("#uploadButton").getAttribute("aria-disabled") === "true"), "Upload trigger stayed disabled after failure");
    await uploadPage.unroute("**/vendor/heic-to.iife.js*");
    await uploadPage.click("#retryButton");
    try {
      await uploadPage.waitForFunction(() => document.getElementById("photoCount")?.textContent === "1", null, { timeout: 30000 });
    } catch (error) {
      throw new Error(`HEIC retry failed: ${await text(uploadPage.locator("#statusNote"))}; ${error.message}`);
    }
    assert(!(await uploadPage.locator("#statusNote").getAttribute("class"))?.includes("is-error"), "HEIC retry reported an error");
    assert(!(await uploadPage.locator("#retryButton").isVisible()), "Retry action should hide after a successful retry");

    // Photos handed over without extension or MIME type (Android pickers) must still be accepted.
    const heicBase64 = fs.readFileSync(heicImage).toString("base64");
    await uploadPage.evaluate(async ({ heicBase64, pngBase64 }) => {
      const toBytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([toBytes(heicBase64)], "image:1001", { type: "" }));
      transfer.items.add(new File([toBytes(pngBase64)], "image:1002", { type: "application/octet-stream" }));
      const input = document.getElementById("fileInput");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, { heicBase64, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn8j3cAAAAASUVORK5CYII=" });
    try {
      await uploadPage.waitForFunction(() => document.getElementById("photoCount")?.textContent === "3", null, { timeout: 30000 });
    } catch (error) {
      throw new Error(`Extensionless upload failed: ${await text(uploadPage.locator("#statusNote"))}; ${error.message}`);
    }

    // A damaged file fails with a readable message, does not offer a pointless retry and does not
    // block the next upload.
    const brokenImage = path.join(os.tmpdir(), "intersection-map-broken.jpg");
    fs.writeFileSync(brokenImage, Buffer.from("not really a jpeg"));
    await uploadPage.locator("#fileInput").setInputFiles(brokenImage);
    await uploadPage.waitForFunction(() => /not supported|damaged/i.test(document.getElementById("statusNote")?.textContent || ""));
    assert(await uploadPage.locator("#loadingOverlay").getAttribute("aria-hidden") === "true", "Broken file left loading overlay open");
    assert(!(await uploadPage.locator("#retryButton").isVisible()), "Broken file should not offer retry");
    await uploadPage.click("#clearButton");
    await uploadPage.waitForFunction(() => document.getElementById("photoCount")?.textContent === "0");
    await uploadPage.locator("#fileInput").setInputFiles(heicImage);
    await uploadPage.waitForFunction(() => document.getElementById("photoCount")?.textContent === "1", null, { timeout: 30000 });

    await uploadPage.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 2600;
      canvas.height = 2200;
      const context = canvas.getContext("2d");
      context.fillStyle = "#a17b60";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "large.png", { type: "image/png" }));
      const input = document.getElementById("fileInput");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await uploadPage.locator("#fileInput").setInputFiles(imageA);
    await uploadPage.waitForFunction(() => document.getElementById("photoCount")?.textContent === "3");
    assert((await uploadPage.locator(".tile").count()) === 3, "Back-to-back uploads lost or duplicated a photo");
    assert(await uploadPage.locator("#loadingOverlay").getAttribute("aria-hidden") === "true", "Upload left loading overlay open");
    const displayedWidths = await uploadPage.locator(".tile img").evaluateAll((nodes) => nodes.map((node) => node.naturalWidth));
    assert(displayedWidths.includes(2048), "Large image was not reduced to 2048 pixels");
    await uploadPage.close();

    // Hidden page / throttled WebView: requestAnimationFrame never fires, upload must still finish.
    const hiddenPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await hiddenPage.addInitScript(() => { window.requestAnimationFrame = () => 0; });
    await hiddenPage.goto(url, { waitUntil: "domcontentloaded" });
    await hiddenPage.locator("#fileInput").setInputFiles(imageA);
    await hiddenPage.waitForFunction(() => document.getElementById("photoCount")?.textContent === "1", null, { polling: 100, timeout: 5000 });

    // A decode that never answers (iOS under memory pressure) must time out instead of freezing the queue.
    await hiddenPage.route("**/never-loads.png", () => {});
    await hiddenPage.evaluate((origin) => {
      uploadLimits.imageLoadTimeoutMs = 400;
      window.__originalCreateObjectURL = URL.createObjectURL;
      URL.createObjectURL = () => `${origin}never-loads.png`;
    }, url);
    await hiddenPage.locator("#fileInput").setInputFiles(imageB);
    await hiddenPage.waitForFunction(() => /took too long/i.test(document.getElementById("statusNote")?.textContent || ""), null, { polling: 100, timeout: 8000 });
    assert(await hiddenPage.locator("#loadingOverlay").getAttribute("aria-hidden") === "true", "Timed-out decode left loading overlay open");
    assert(await hiddenPage.locator("#retryButton").isVisible(), "Timed-out decode should offer retry");
    await hiddenPage.evaluate(() => { URL.createObjectURL = window.__originalCreateObjectURL; });
    await hiddenPage.click("#retryButton");
    await hiddenPage.waitForFunction(() => document.getElementById("photoCount")?.textContent === "2", null, { polling: 100, timeout: 5000 });
    await hiddenPage.close();

    // Slow batches must show visible progress, finished thumbnails and a way to stop.
    const slowPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await slowPage.goto(url, { waitUntil: "domcontentloaded" });
    await slowPage.evaluate(() => {
      const input = document.getElementById("fileInput");
      input.dispatchEvent(new MouseEvent("click"));
      window.__waitingShown = document.getElementById("workspace").classList.contains("is-waiting");
      input.dispatchEvent(new Event("cancel"));
      window.__waitingCleared = !document.getElementById("workspace").classList.contains("is-waiting");
      const realCreateAsset = window.createAsset;
      window.createAsset = async (file) => {
        await new Promise((resolve) => setTimeout(resolve, 3500));
        return realCreateAsset(file);
      };
    });
    assert(await slowPage.evaluate(() => window.__waitingShown && window.__waitingCleared), "Picker wait state should show on open and clear on cancel");
    await slowPage.locator("#fileInput").setInputFiles([imageA, imageB, imageA]);
    await slowPage.waitForFunction(() => document.getElementById("loadingTitle")?.textContent === "1 of 3 done", null, { timeout: 10000 });
    assert(await slowPage.locator("#loadingThumbs img").count() === 1, "Finished image should appear as a thumbnail while the rest load");
    assert(await slowPage.locator("#stopUploadButton").isVisible(), "Stop should be offered during a multi-image upload");
    await slowPage.waitForFunction(() => /now: .* · \d+s/.test(document.getElementById("loadingMeta")?.textContent || ""), null, { timeout: 3200 });
    await slowPage.click("#stopUploadButton");
    assert(await text(slowPage.locator("#stopUploadButton")) === "stopping…", "Stop should confirm it was pressed");
    await slowPage.waitForFunction(() => /^Stopped\./.test(document.getElementById("statusNote")?.textContent || ""), null, { timeout: 10000 });
    assert(await text(slowPage.locator("#photoCount")) === "2", "Stop should keep the images prepared so far, including the one in progress");
    assert(await slowPage.locator("#loadingOverlay").getAttribute("aria-hidden") === "true", "Loading overlay should close after stopping");
    await slowPage.close();

    // Phone flow: format buttons, export through the share sheet, autosave across a reload.
    const phonePage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phonePage.addInitScript(() => {
      window.__shared = [];
      window.__shareAttempts = 0;
      navigator.canShare = () => true;
      navigator.share = async (data) => {
        window.__shareAttempts += 1;
        if (window.__refuseFirstShare && window.__shareAttempts === 1) {
          throw new DOMException("needs a fresh tap", "NotAllowedError");
        }
        window.__shared.push(data.files[0].name);
      };
    });
    await phonePage.goto(url, { waitUntil: "domcontentloaded" });
    assert(await text(phonePage.locator("#canvasLabel")) === "1080 × 1920", "Phones should start with a 9:16 field");
    assert(await phonePage.locator('.format-preset[data-height="1920"]').getAttribute("aria-pressed") === "true", "9:16 should show as the current format");
    await phonePage.locator("#fileInput").setInputFiles([imageA, imageB]);
    await phonePage.waitForFunction(() => document.getElementById("photoCount")?.textContent === "2", null, { timeout: 10000 });
    await phonePage.click('.format-preset[data-height="1350"]');
    assert(await text(phonePage.locator("#canvasLabel")) === "1080 × 1350", "4:5 button should set the field size");
    assert(await phonePage.locator('.format-preset[data-height="1350"]').getAttribute("aria-pressed") === "true", "4:5 should show as the current format");
    assert(await phonePage.locator("#updateButton").evaluate((node) => node.classList.contains("cta")), "Changing the format should point to arrange");
    await phonePage.click("#updateButton");

    await phonePage.click("#exportButton");
    await phonePage.waitForFunction(() => window.__shared.length === 1, null, { timeout: 10000 });
    assert(await phonePage.evaluate(() => window.__shared[0]) === "intersection-map-1080x1350.png", "Phone export should go through the share sheet");
    await phonePage.evaluate(() => { window.__refuseFirstShare = true; window.__shareAttempts = 0; });
    await phonePage.click("#exportButton");
    await phonePage.waitForFunction(() => !document.getElementById("shareButton").hidden, null, { timeout: 10000 });
    await phonePage.click("#shareButton");
    await phonePage.waitForFunction(() => window.__shared.length === 2, null, { timeout: 5000 });
    assert(await phonePage.locator("#shareButton").isHidden(), "Share button should hide once used");

    // Wait for the debounced autosave, then reload as iOS does with background tabs.
    await phonePage.waitForTimeout(1200);
    await phonePage.reload({ waitUntil: "domcontentloaded" });
    await phonePage.waitForFunction(() => document.getElementById("photoCount")?.textContent === "2", null, { timeout: 10000 });
    assert(/^Restored your last composition/.test(await text(phonePage.locator("#statusNote"))), "Reload should restore the composition");
    assert(await text(phonePage.locator("#canvasLabel")) === "1080 × 1350", "Reload should restore the field size");
    assert(await phonePage.locator(".tile img").count() === 2, "Restored tiles should show their images");
    assert(await phonePage.locator(".tile img").first().evaluate((img) => img.complete && img.naturalWidth > 0), "Restored images should load");
    await phonePage.click("#clearButton");
    await phonePage.waitForTimeout(1200);
    await phonePage.reload({ waitUntil: "domcontentloaded" });
    await phonePage.waitForTimeout(800);
    assert(await text(phonePage.locator("#photoCount")) === "0", "Clear all should also clear the saved composition");
    await phonePage.close();

    assert(pageErrors.length === 0, `JavaScript errors on the page:\n${[...new Set(pageErrors)].join("\n")}`);
    assert(cspViolations.length === 0, `Content Security Policy blocked something:\n${[...new Set(cspViolations)].join("\n")}`);
    console.log("smoke-test: ok");
  } finally {
    // When a page error makes an earlier step time out, show the real cause too.
    if (pageErrors.length) console.error(`JavaScript errors seen on the page:\n${[...new Set(pageErrors)].join("\n")}`);
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

main().catch((error) => {
  console.error("smoke-test: failed");
  console.error(error);
  process.exit(1);
});
