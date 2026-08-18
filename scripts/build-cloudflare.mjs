import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), "..");
const outputDir = path.join(projectRoot, "dist-static");
const publicDir = path.join(projectRoot, "public");

const rootFiles = ["index.html", "style.css", "app.js", "_headers"];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const publicEntries = await readdir(publicDir, { withFileTypes: true }).catch(() => []);

for (const entry of publicEntries) {
  const from = path.join(publicDir, entry.name);
  const to = path.join(outputDir, entry.name);
  await cp(from, to, { recursive: true });
}

for (const relativePath of rootFiles) {
  const from = path.join(projectRoot, relativePath);
  const to = path.join(outputDir, relativePath);
  await cp(from, to, { recursive: true });
}

console.log(`Cloudflare bundle ready in ${path.relative(projectRoot, outputDir)}`);
