import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");

await mkdir(publicDir, { recursive: true });
await cp(path.join(projectRoot, "app.js"), path.join(publicDir, "app.js"));
