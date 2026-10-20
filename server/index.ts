import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { loadEnv } from "./env.ts";
import { jevConfigured } from "./jev.ts";
import { Store } from "./db.ts";
import { scanDownloads } from "./scan.ts";
import { thumbPath } from "./thumbs.ts";
import { moveToTrash, restoreFromTrash } from "./trash.ts";
import type { Progress, ScanResult } from "../shared/types.ts";

loadEnv();

const clientDir = resolve(process.env.CLIENT_DIR ?? join(process.cwd(), "dist", "client"));
const port = Number(process.env.PORT) || 8787;

const store = new Store();
const downloadsRoot = join(homedir(), "Downloads");
let active: AbortController | null = null;
let latest: ScanResult | null = null;

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Request failed";
    sendJson(res, 500, { error: message });
  });
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? "Port 8787 is already in use." : "The local server could not start.");
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`ready http://127.0.0.1:${actual}`);
});

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    active?.abort();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:8787");
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, jevConfigured: jevConfigured() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/result") {
    if (!latest) {
      sendJson(res, 404, { error: "No scan yet" });
      return;
    }
    sendJson(res, 200, latest);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/undo") {
    const entry = store.latestJournal();
    sendJson(res, 200, {
      available: Boolean(entry),
      count: entry?.items.length ?? 0,
      createdAt: entry?.createdAt ?? null,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/scan") {
    await streamScan(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/trash") {
    await trash(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/keep") {
    await keep(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/unkeep") {
    await unkeep(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/undo") {
    await undo(res);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/file/")) {
    await previewFile(url.pathname.slice("/api/file/".length), res);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/thumbs/")) {
    await thumb(url.pathname.slice("/thumbs/".length), res);
    return;
  }
  if (req.method === "GET") {
    await serveClient(url.pathname, res);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

const CLIENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

async function serveClient(pathname: string, res: ServerResponse) {
  let root = "";
  try {
    root = await realpath(clientDir);
  } catch {
    sendJson(res, 404, { error: "UI is not built" });
    return;
  }
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) {
    sendJson(res, 400, { error: "Bad path" });
    return;
  }
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const real = await realpath(target);
    if (real !== root && !real.startsWith(root + sep)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    const bytes = await readFile(real);
    const type = CLIENT_TYPES[extname(real)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(bytes);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function streamScan(req: IncomingMessage, res: ServerResponse) {
  active?.abort();
  const controller = new AbortController();
  active = controller;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let finished = false;
  res.on("close", () => {
    if (!finished) controller.abort();
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const result = await scanDownloads({
      store,
      signal: controller.signal,
      onProgress: (progress: Progress) => send("progress", progress),
    });
    latest = result;
    finished = true;
    send("result", result);
  } catch (error) {
    finished = true;
    const message = controller.signal.aborted ? "Scan cancelled" : error instanceof Error ? error.message : "Scan failed";
    send("error", { message });
  } finally {
    if (active === controller) active = null;
    res.end();
  }
}

async function trash(req: IncomingMessage, res: ServerResponse) {
  const body = (await readJson(req)) as { files?: { path: string; size: number; mtimeMs: number }[] };
  const requested = Array.isArray(body.files) ? body.files : [];
  const root = await realpath(downloadsRoot);
  const accepted: { path: string; size: number; mtimeMs: number; name: string }[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const file of requested) {
    try {
      const checked = await assertFile(root, file.path, file.size, file.mtimeMs);
      accepted.push(checked);
    } catch (error) {
      failed.push({ path: file.path, error: error instanceof Error ? error.message : "Rejected" });
    }
  }
  const moved = await moveToTrash(accepted.map((file) => file.path));
  const journalItems = [];
  const movedItems: { originalPath: string; trashPath: string | null; name: string }[] = [];
  for (const item of moved) {
    const known = accepted.find((file) => file.path === item.original);
    if (!known || item.error) {
      failed.push({ path: item.original, error: item.error ?? "Finder did not move this file" });
      continue;
    }
    movedItems.push({ originalPath: item.original, trashPath: item.trashPath, name: known.name });
    if (item.trashPath) journalItems.push({ originalPath: item.original, trashPath: item.trashPath, name: known.name });
  }
  const journalId = journalItems.length ? store.addJournal(journalItems) : null;
  if (latest) {
    const gone = new Set(movedItems.map((item) => item.originalPath));
    latest = { ...latest, files: latest.files.filter((file) => !gone.has(file.path)) };
  }
  sendJson(res, 200, { journalId, moved: movedItems, failed });
}

async function keep(req: IncomingMessage, res: ServerResponse) {
  const body = (await readJson(req)) as { files?: { path: string; size: number; mtimeMs: number }[] };
  const requested = Array.isArray(body.files) ? body.files : [];
  const root = await realpath(downloadsRoot);
  const accepted: { path: string; size: number; mtimeMs: number }[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const file of requested) {
    try {
      const checked = await assertFile(root, file.path, file.size, file.mtimeMs);
      accepted.push(checked);
    } catch (error) {
      failed.push({ path: file.path, error: error instanceof Error ? error.message : "Rejected" });
    }
  }
  if (accepted.length) store.keep(accepted);
  if (latest) {
    const gone = new Set(accepted.map((file) => file.path));
    latest = {
      ...latest,
      files: latest.files.map((file) => (gone.has(file.path) ? { ...file, userKept: true } : file)),
    };
  }
  sendJson(res, 200, { kept: accepted.length, failed });
}

async function unkeep(req: IncomingMessage, res: ServerResponse) {
  const body = (await readJson(req)) as { paths?: string[] };
  const paths = Array.isArray(body.paths) ? body.paths.filter((path) => typeof path === "string") : [];
  const removed = paths.length ? store.forget(paths) : 0;
  if (latest) {
    const gone = new Set(paths);
    const kept = latest.kept.filter((file) => !gone.has(file.path));
    latest = { ...latest, kept, hiddenCount: kept.length };
  }
  sendJson(res, 200, { removed });
}

async function undo(res: ServerResponse) {
  const entry = store.latestJournal();
  if (!entry) {
    sendJson(res, 404, { error: "Nothing to undo" });
    return;
  }
  const restored = await restoreFromTrash(
    entry.items.map((item) => ({
      originalPath: item.originalPath,
      trashPath: item.trashPath,
      originalDir: dirname(item.originalPath),
    })),
  );
  const failures = restored.filter((item) => !item.ok);
  if (failures.length === 0) store.markUndone(entry.id);
  sendJson(res, 200, {
    restored: restored.filter((item) => item.ok).length,
    failed: failures,
  });
}

const PREVIEW_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
};

async function previewFile(id: string, res: ServerResponse) {
  if (!/^[a-f0-9]{16}$/.test(id) || !latest) {
    sendJson(res, 404, { error: "No preview" });
    return;
  }
  const file = latest.files.find((item) => item.id === id) ?? latest.kept.find((item) => item.id === id);
  if (!file) {
    sendJson(res, 404, { error: "No preview" });
    return;
  }
  const type = PREVIEW_TYPES[file.ext] ?? "";
  if (!type) {
    sendJson(res, 415, { error: "This file has no preview" });
    return;
  }
  const root = await realpath(downloadsRoot);
  const real = await realpath(file.path);
  if (real !== root && !real.startsWith(root + sep)) {
    sendJson(res, 403, { error: "Path is outside Downloads" });
    return;
  }
  const bytes = await readFile(real);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": "inline",
    "Cache-Control": "private, max-age=60",
  });
  res.end(bytes);
}

async function thumb(id: string, res: ServerResponse) {
  if (!/^[a-f0-9]{16}$/.test(id)) {
    sendJson(res, 400, { error: "Bad thumbnail id" });
    return;
  }
  try {
    const bytes = await readFile(thumbPath(id));
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
    res.end(bytes);
  } catch {
    sendJson(res, 404, { error: "No thumbnail" });
  }
}

async function assertFile(root: string, filePath: string, size: number, mtimeMs: number) {
  const resolved = resolve(filePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error("Path is outside Downloads");
  }
  const real = await realpath(resolved);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error("Path is outside Downloads");
  }
  const fileStat = await stat(real);
  if (!fileStat.isFile()) throw new Error("Not a file");
  if (fileStat.size !== size || Math.round(fileStat.mtimeMs) !== mtimeMs) {
    throw new Error("File changed since the scan");
  }
  return { path: real, size: fileStat.size, mtimeMs: Math.round(fileStat.mtimeMs), name: real.split(sep).pop() ?? real };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 5_000_000) {
        reject(new Error("Request is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
