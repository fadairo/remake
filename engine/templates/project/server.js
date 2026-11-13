// Passcode gate and static server for this remake (runs on Google Cloud Run, or anywhere Node 20 runs).
// Every page, file and the /_remake/ proof pages stay private until the passcode is entered.
// The passcode lives in the REMAKE_PASSCODE environment variable (a Secret Manager secret on Cloud Run).
// Remove it to open the site.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const COOKIE = "remake_pass";
const ROBOTS = { "x-robots-tag": "noindex, nofollow" };

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".wasm": "application/wasm", ".pdf": "application/pdf",
};

function digest(text) {
  return crypto.createHash("sha256").update("remake:" + text.trim().toLowerCase()).digest("hex");
}

function same(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function gate(nextPath, wrong) {
  const safe = nextPath.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Private preview</title>
<style>:root{--ink:#15171b;--muted:#5b626d;--line:#dde0e5;--accent:#ff5a1f}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
form{background:#fff;border:1px solid var(--line);border-radius:14px;padding:28px;width:min(100%,380px);display:grid;gap:14px}h1{font:800 24px/1.1 inherit;letter-spacing:-.03em;margin:0}p{margin:0;color:var(--muted)}
input{font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:8px}input:focus{outline:2px solid var(--accent);outline-offset:1px}button{font:600 15px/1 inherit;letter-spacing:-.01em;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px;cursor:pointer}.err{color:#c4321b}</style></head>
<body><form method="post" action="/_remake/gate" data-remake-gate><h1>Private preview</h1><p>This site is a work in progress. Enter the passcode to see it.</p>${wrong ? '<p class="err">That passcode didn\'t work.</p>' : ""}
<input type="hidden" name="next" value="${safe}"><input name="passcode" type="password" autocomplete="current-password" placeholder="Passcode" aria-label="Passcode" required autofocus><button type="submit">Open</button></form></body></html>`;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function resolveFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  const base = path.join(ROOT, path.normalize(rel));
  if (base !== ROOT && !base.startsWith(ROOT + path.sep)) return null;
  for (const c of [base, path.join(base, "index.html"), base + ".html"]) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

function serveFile(req, res, file) {
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const size = fs.statSync(file).size;
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=300", ...ROBOTS };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}`, ...ROBOTS });
      return res.end();
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain", ...ROBOTS });
    return res.end("User-agent: *\nDisallow: /\n");
  }
  const passcode = process.env.REMAKE_PASSCODE;
  const expected = passcode ? digest(passcode) : null;

  if (expected && url.pathname === "/_remake/gate" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    let dest = form.get("next") || "/";
    if (!dest.startsWith("/") || dest.startsWith("//") || dest.startsWith("/\\")) dest = "/";
    if (!same(digest(form.get("passcode") || ""), expected)) {
      res.writeHead(303, { location: dest + (dest.includes("?") ? "&" : "?") + "remake_wrong=1", ...ROBOTS });
      return res.end();
    }
    res.writeHead(303, {
      location: dest,
      "set-cookie": `${COOKIE}=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000`,
      ...ROBOTS,
    });
    return res.end();
  }

  if (expected) {
    const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
    if (!cookie || !same(cookie.slice(COOKIE.length + 1), expected)) {
      const nextPath = url.pathname.startsWith("/_remake/gate") ? "/" : url.pathname + url.search;
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...ROBOTS });
      return res.end(gate(nextPath, url.searchParams.has("remake_wrong")));
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", ...ROBOTS });
    return res.end();
  }
  const file = resolveFile(url.pathname);
  if (file) return serveFile(req, res, file);
  const notFound = path.join(ROOT, "404.html");
  res.writeHead(404, { "content-type": "text/html; charset=utf-8", ...ROBOTS });
  res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : "Not found");
}

http
  .createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, ROBOTS);
      res.end();
    });
  })
  .listen(Number(process.env.PORT) || 8080, "0.0.0.0");
