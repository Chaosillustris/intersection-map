const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const url = "http://127.0.0.1:8000/";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function writeFixture(fileName, base64) {
  const target = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(target, Buffer.from(base64, "base64"));
  return target;
}

async function text(locator) {
  return (await locator.textContent())?.trim() || "";
}

async function resizeSelectedTile(page) {
  const selectedTile = page.locator(".tile.is-selected");
  const dragVectors = [
    { dx: 120, dy: 120 },
    { dx: 84, dy: 148 },
    { dx: 148, dy: 84 },
  ];

  for (const vector of dragVectors) {
    const before = await selectedTile.boundingBox();
    const overlayHandle = page.locator(".selection-overlay [data-handle='xy']");
    const overlayHandleBox = await overlayHandle.boundingBox();
    if (!before || !overlayHandleBox) {
      return false;
    }

    await page.mouse.move(
      overlayHandleBox.x + overlayHandleBox.width / 2,
      overlayHandleBox.y + overlayHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      overlayHandleBox.x + overlayHandleBox.width / 2 + vector.dx,
      overlayHandleBox.y + overlayHandleBox.height / 2 + vector.dy,
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

  return false;
}

async function main() {
  const imageA = writeFixture(
    "intersection-map-a.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn8j3cAAAAASUVORK5CYII=",
  );
  const imageB = writeFixture(
    "intersection-map-b.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AApMBgU6PvxQAAAAASUVORK5CYII=",
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });

    assert((await page.title()) === "intersection map / 01", "Unexpected page title");

    const buttons = [
      "#uploadButton",
      "#updateButton",
      "#scatterButton",
      "#mutateButton",
      "#exportButton",
      "#gridButton",
      "#toneButton",
      "#applyCanvasSizeButton",
    ];

    for (const selector of buttons) {
      assert(await page.locator(selector).count(), `Missing control: ${selector}`);
    }

    assert(await page.locator("#updateButton").isDisabled(), "Update should start disabled");
    assert(await page.locator("#scatterButton").isDisabled(), "Scatter should start disabled");
    assert(await page.locator("#mutateButton").isDisabled(), "Mutate should start disabled");
    assert(await page.locator("#exportButton").isDisabled(), "Export should start disabled");

    await page.locator("#fileInput").setInputFiles([imageA, imageB]);
    await page.waitForFunction(() => document.querySelectorAll(".tile").length === 2);
    await page.waitForFunction(
      () => document.getElementById("photoCount")?.textContent?.trim() === "2",
    );

    assert(!(await page.locator("#scatterButton").isDisabled()), "Scatter should enable after upload");
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
    assert((await text(page.locator("#updateButton"))).includes("*"), "Update indicator did not appear");

    await page.fill("#canvasWidthInput", "1320");
    await page.fill("#canvasHeightInput", "980");
    await page.click("#applyCanvasSizeButton");
    await page.waitForFunction(
      () => document.getElementById("canvasLabel")?.textContent?.trim() === "1320 × 980",
    );

    const firstTile = page.locator(".tile").first();
    await firstTile.click({ position: { x: 12, y: 12 } });
    await page.waitForFunction(
      () => /selected/i.test(document.getElementById("inspector")?.textContent || ""),
    );
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
      () => /Crop mode:/i.test(document.getElementById("workspaceNote")?.textContent || ""),
    );
    await page.waitForFunction(() => {
      const inspector = document.getElementById("inspector")?.textContent || "";
      const match = inspector.match(/crop\s+(\d+)%/i);
      return match ? Number(match[1]) > 100 : false;
    });
    const cropPositionBefore = await selectedTile.locator("img").evaluate((node) => node.style.objectPosition);
    const cropBox = await selectedTile.boundingBox();
    assert(cropBox, "Could not read crop box");
    await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2 + 24, {
      steps: 8,
    });
    await page.mouse.up();
    const cropPositionAfter = await selectedTile.locator("img").evaluate((node) => node.style.objectPosition);
    assert(cropPositionAfter !== cropPositionBefore, "Crop drag did not update image position");
    await page.mouse.wheel(0, -240);
    await page.waitForFunction(
      () => /%/.test(document.getElementById("inspector")?.textContent || ""),
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !/Crop mode:/i.test(document.getElementById("workspaceNote")?.textContent || ""),
    );

    await page.click('[data-action="anchor"]');
    await page.waitForFunction(
      () => document.getElementById("anchorLabel")?.textContent?.trim() !== "none",
    );
    assert(
      /pinned as anchor/i.test(await text(page.locator("#statusNote"))),
      "Anchor status message did not appear",
    );

    await page.click("#updateButton");
    await page.waitForFunction(
      () => /Composition updated/i.test(document.getElementById("statusNote")?.textContent || ""),
    );

    await page.click('[data-action="replace"]');
    await page.locator("#replaceInput").setInputFiles(imageB);
    await page.waitForFunction(
      () => /Replaced/i.test(document.getElementById("statusNote")?.textContent || ""),
    );

    await page.click('[data-action="lock"]');
    assert(/unlock/i.test(await text(page.locator('[data-action="lock"]'))), "Lock toggle failed");

    const topLayerTitleBefore = await text(page.locator(".layer-card .layer-title").first());
    await page.locator(".layer-card").nth(1).click();
    assert(
      await page.locator(".layer-card").nth(1).evaluate((node) => node.classList.contains("is-selected")),
      "Layer click did not select tile",
    );
    const topLayerTitleAfterSelect = await text(page.locator(".layer-card .layer-title").first());
    assert(topLayerTitleAfterSelect === topLayerTitleBefore, "Layer click should not surface tile");

    await page.locator(".layer-card").nth(1).dragTo(page.locator(".layer-card").first());
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

    console.log("smoke-test: ok");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("smoke-test: failed");
  console.error(error);
  process.exit(1);
});
