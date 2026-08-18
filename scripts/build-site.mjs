import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const serverDir = path.join(distDir, "server");

async function main() {
  const [htmlSource, cssSource, jsSource] = await Promise.all([
    readFile(path.join(projectRoot, "index.html"), "utf8"),
    readFile(path.join(projectRoot, "style.css"), "utf8"),
    readFile(path.join(projectRoot, "app.js"), "utf8"),
  ]);

  const html = buildHtmlDocument(htmlSource, cssSource, jsSource);
  const workerSource = buildWorkerSource(html);

  await rm(distDir, { recursive: true, force: true });
  await mkdir(serverDir, { recursive: true });

  await Promise.all([
    writeFile(path.join(distDir, "index.html"), html),
    writeFile(path.join(serverDir, "index.js"), workerSource),
  ]);
}

function buildHtmlDocument(htmlSource, cssSource, jsSource) {
  const stylesheetTag = '<link rel="stylesheet" href="./style.css" />';
  const scriptTag = '<script src="./app.js"></script>';
  const inlinedCss = `<style>\n${cssSource}\n</style>`;
  const inlinedJs = `<script>\n${escapeInlineScript(jsSource)}\n</script>`;

  return htmlSource.replace(stylesheetTag, inlinedCss).replace(scriptTag, inlinedJs);
}

function buildWorkerSource(html) {
  const payload = JSON.stringify(html);

  return `const html = ${payload};

const headers = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=60"
};

function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" }
    });
  }

  if (url.pathname === "/health") {
    return new Response("ok", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers
  });
}

export default {
  fetch(request) {
    return handleRequest(request);
  }
};
`;
}

function escapeInlineScript(scriptSource) {
  return scriptSource.replace(/<\/script/gi, "<\\\\/script");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
