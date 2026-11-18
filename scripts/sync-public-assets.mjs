import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");
const packageJsonPath = path.join(projectRoot, "package.json");
const versionScriptPath = path.join(projectRoot, "version.js");
const publicVersionScriptPath = path.join(publicDir, "version.js");

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const builtAt = new Date().toISOString();
const versionScript = `window.__INTERSECTION_MAP_VERSION__ = Object.freeze(${JSON.stringify(
  {
    version: packageJson.version,
    builtAt,
  },
)});
`;

await mkdir(publicDir, { recursive: true });
await writeFile(versionScriptPath, versionScript);
await writeFile(publicVersionScriptPath, versionScript);
await cp(path.join(projectRoot, "app.js"), path.join(publicDir, "app.js"));
await cp(path.join(projectRoot, "vendor"), path.join(publicDir, "vendor"), { recursive: true });
