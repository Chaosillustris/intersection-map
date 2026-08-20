# Intersection Map QA Checklist

Run this checklist after every UI or interaction change.

## Critical flow

1. Start the local app and confirm the visible version label changed as expected.
2. Upload photos through `add photos`.
3. Upload photos by drag-and-drop onto the field.
4. Confirm the photo count, tiles, layers panel, and loading overlay all react correctly.
5. Check `update`, `scatter`, `mutate`, `export`, and `clear all`.
6. Confirm `clear all` fully resets the workspace without changing field size or sliders.
7. Select a tile and verify `replace`, `crop`, `lock`, `anchor`, and `delete`.

## Layout

1. Confirm the action row stays on one line on desktop.
2. Confirm the action row stays readable on mobile.
3. Confirm the version label is visible in both local and deployed builds.

## Regression checks

1. Run `node smoke-test.cjs`.
2. Run `npm run build:cloudflare`.
3. If the published site should change, deploy it after the local checks pass.
4. After deployment, open the published site and compare its visible version label with the local one.

## Why this matters

- Local edits do not update the published site automatically.
- A GitHub push does not update the published site automatically.
- The published site must be redeployed after code changes.
- The version label is the quickest way to confirm which build is on screen.
