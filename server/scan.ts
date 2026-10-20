import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { appForInstaller, installedAppNames } from "./apps.ts";
import { sha256File } from "./hash.ts";
import { classifyDocument, isKeyRejected, jevConfigured, safeError } from "./jev.ts";
import { JevCache } from "./jevCache.ts";
import { pool } from "./pool.ts";
import { textSample } from "./sample.ts";
import { readSpotlight } from "./spotlight.ts";
import { ensureThumb } from "./thumbs.ts";
import type { Store } from "./db.ts";
import {
  isDocumentExt,
  isImageExt,
  isInstallerExt,
  isScreenshotName,
  isVideoExt,
} from "../shared/signals.ts";
import { LARGE_VIDEO_BYTES, type FileRecord, type Progress, type Rule, type ScanResult } from "../shared/types.ts";

const DAY = 24 * 60 * 60 * 1000;
const THUMB_LIMIT = 40 * 1024 * 1024;

type Entry = {
  path: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  contentType: string | null;
  addedMs: number | null;
  lastUsedMs: number | null;
  whereFrom: string | null;
  hash: string | null;
  userKept: boolean;
};

export async function scanDownloads(options: {
  store: Store;
  signal: AbortSignal;
  onProgress: (progress: Progress) => void;
  downloadsPath?: string;
}): Promise<ScanResult> {
  const downloadsPath = options.downloadsPath ?? join(homedir(), "Downloads");
  const root = await realpath(downloadsPath);
  throwIfAborted(options.signal);

  options.onProgress({ phase: "listing", done: 0, total: 0, detail: "Listing Downloads" });
  const paths = await walk(root, options.signal);
  const entries: Entry[] = [];

  for (const filePath of paths) {
    throwIfAborted(options.signal);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    const mtimeMs = Math.round(fileStat.mtimeMs);
    const userKept = Boolean(options.store.keptMatch(filePath, fileStat.size, mtimeMs));
    entries.push({
      path: filePath,
      name: basename(filePath),
      ext: extname(filePath).toLowerCase(),
      size: fileStat.size,
      mtimeMs,
      birthtimeMs: Math.round(fileStat.birthtimeMs),
      contentType: null,
      addedMs: null,
      lastUsedMs: null,
      whereFrom: null,
      hash: null,
      userKept,
    });
  }

  options.onProgress({
    phase: "metadata",
    done: 0,
    total: entries.length,
    detail: "Reading Finder details",
  });
  let metadataDone = 0;
  await pool(entries, 16, async (entry) => {
    throwIfAborted(options.signal);
    const meta = await readSpotlight(entry.path);
    entry.contentType = meta.contentType;
    entry.addedMs = meta.addedMs;
    entry.lastUsedMs = meta.lastUsedMs;
    entry.whereFrom = meta.whereFrom;
    metadataDone += 1;
    if (metadataDone % 25 === 0 || metadataDone === entries.length) {
      options.onProgress({
        phase: "metadata",
        done: metadataDone,
        total: entries.length,
        detail: "Reading Finder details",
      });
    }
  });

  const bySize = new Map<number, Entry[]>();
  for (const entry of entries) {
    if (entry.size === 0) continue;
    const list = bySize.get(entry.size);
    if (list) list.push(entry);
    else bySize.set(entry.size, [entry]);
  }
  const toHash = [...bySize.values()].filter((group) => group.length > 1).flat();
  options.onProgress({
    phase: "duplicates",
    done: 0,
    total: toHash.length,
    detail: toHash.length ? "Checking for exact copies" : "No same-size files to compare",
  });
  let hashed = 0;
  await pool(toHash, 2, async (entry) => {
    throwIfAborted(options.signal);
    try {
      entry.hash = await sha256File(entry.path, options.signal);
    } catch (error) {
      if (options.signal.aborted) throw error;
      entry.hash = null;
    }
    hashed += 1;
    options.onProgress({
      phase: "duplicates",
      done: hashed,
      total: toHash.length,
      detail: "Checking for exact copies",
    });
  });

  const duplicateOf = duplicateKeepers(entries);
  const apps = await installedAppNames();
  const configured = jevConfigured();
  const files: FileRecord[] = entries.map((entry) => toRecord(entry, duplicateOf.get(entry.path) ?? null, apps));

  const images = files.filter((file) => file.isImage && file.size <= THUMB_LIMIT && file.size > 0);
  options.onProgress({
    phase: "thumbnails",
    done: 0,
    total: images.length,
    detail: images.length ? "Making thumbnails" : "No thumbnails needed",
  });
  let thumbs = 0;
  await pool(images, 6, async (file) => {
    throwIfAborted(options.signal);
    try {
      await ensureThumb(file.id, file.path, file.mtimeMs);
    } catch {
      // A missing thumbnail still leaves the file in the list.
    }
    thumbs += 1;
    if (thumbs % 20 === 0 || thumbs === images.length) {
      options.onProgress({
        phase: "thumbnails",
        done: thumbs,
        total: images.length,
        detail: "Making thumbnails",
      });
    }
  });

  const documents = files.filter((file) => file.rule === "document" && !file.userKept);
  options.onProgress({
    phase: "classifying",
    done: 0,
    total: documents.length,
    detail: configured ? "Asking Jev about documents" : "Jev is not configured",
  });
  let classified = 0;
  let keyRejected = false;
  if (configured) {
    const cache = new JevCache();
    await cache.load();
    let reused = 0;
    let sent = 0;
    try {
      await pool(documents, 3, async (file) => {
        throwIfAborted(options.signal);
        const saved = cache.match(file.path, file.name, file.size);
        if (keyRejected) {
          file.jev = null;
          file.jevSkippedReason = "Left in Review.";
        } else if (saved) {
          file.jev = saved.jev;
          file.textSample = saved.textSample;
          file.sampleSent = Boolean(saved.textSample);
          reused += 1;
        } else {
          try {
            const sample = await textSample(file.path, file.ext, file.size);
            file.textSample = sample;
            file.sampleSent = Boolean(sample);
            file.jev = await withTimeout(
              classifyDocument({
                file_name: file.name,
                extension: file.ext || null,
                size_bytes: file.size,
                age_days: file.ageDays,
                last_opened: file.lastUsedMs ? new Date(file.lastUsedMs).toISOString().slice(0, 10) : null,
                download_source: file.whereFrom,
                text_sample: sample ?? "",
              }),
              45_000,
            );
            if (file.jev) {
              cache.remember(file.path, {
                name: file.name,
                size: file.size,
                jev: file.jev,
                textSample: file.textSample,
              });
            }
            sent += 1;
          } catch (error) {
            if (options.signal.aborted) throw error;
            file.jev = null;
            if (isKeyRejected(error)) {
              keyRejected = true;
              file.jevSkippedReason = "Left in Review.";
            } else {
              file.jevSkippedReason = `Jev could not classify this file (${safeError(error)}). Left in Review.`;
            }
          }
        }
        classified += 1;
        options.onProgress({
          phase: "classifying",
          done: classified,
          total: documents.length,
          detail: `${sent} sent to Jev, ${reused} reused`,
        });
      });
    } finally {
      await cache.flush();
    }
  } else {
    for (const file of documents) {
      file.jevSkippedReason = "Jev is not configured, so this document was not classified. Left in Review.";
    }
  }

  options.onProgress({ phase: "done", done: files.length, total: files.length, detail: "Scan complete" });
  return {
    files,
    kept: [],
    hiddenCount: 0,
    jevConfigured: configured,
    jevKeyRejected: keyRejected,
    downloadsPath: root,
    scannedAt: Date.now(),
  };
}

function isImageContentType(contentType: string | null): boolean {
  const type = contentType?.toLowerCase() ?? "";
  if (!type || type.includes("disk-image") || type.includes("diskimage")) return false;
  return type.startsWith("public.png") || type.startsWith("public.jpeg") || type.startsWith("public.gif") || type.startsWith("public.tiff") || type.startsWith("public.heic") || type.startsWith("public.webp") || type.startsWith("public.avif") || type.startsWith("image/");
}

function fileId(path: string): string {
  return createHash("sha1").update(path).digest("hex").slice(0, 16);
}

function toRecord(entry: Entry, duplicateOf: { id: string; name: string } | null, apps: string[]): FileRecord {
  const addedMs = entry.addedMs ?? (entry.birthtimeMs || entry.mtimeMs);
  const ageDays = Math.max(0, Math.floor((Date.now() - addedMs) / DAY));
  const image = isImageExt(entry.ext) || isImageContentType(entry.contentType);
  const video = isVideoExt(entry.ext) || (entry.contentType?.includes("movie") ?? false) || (entry.contentType?.includes("video") ?? false);
  const installer = isInstallerExt(entry.ext);
  const screenshot = image && isScreenshotName(entry.name);
  const document = isDocumentCandidate(entry);
  let rule: Rule = "plain";
  if (video && entry.size > LARGE_VIDEO_BYTES) rule = "large-video";
  else if (screenshot) rule = "screenshot";
  else if (installer) rule = "installer";
  else if (document) rule = "document";
  if (duplicateOf) rule = "duplicate";

  return {
    id: fileId(entry.path),
    path: entry.path,
    name: entry.name,
    ext: entry.ext,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    addedMs,
    lastUsedMs: entry.lastUsedMs,
    whereFrom: entry.whereFrom,
    ageDays,
    rule,
    isImage: image,
    duplicateOfId: duplicateOf?.id ?? null,
    duplicateOfName: duplicateOf?.name ?? null,
    userKept: entry.userKept,
    installedApp: installer ? appForInstaller(entry.name, apps) : null,
    textSample: null,
    sampleSent: false,
    jev: null,
    jevSkippedReason: null,
  };
}

function isDocumentCandidate(entry: Entry): boolean {
  if (isDocumentExt(entry.ext)) return true;
  if (entry.ext) return false;
  const type = entry.contentType ?? "";
  return type.includes("pdf") || type.includes("text") || type.includes("json");
}

function duplicateKeepers(entries: Entry[]): Map<string, { id: string; name: string }> {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!entry.hash) continue;
    const list = groups.get(entry.hash);
    if (list) list.push(entry);
    else groups.set(entry.hash, [entry]);
  }
  const extras = new Map<string, { id: string; name: string }>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      const added = (b.addedMs ?? b.mtimeMs) - (a.addedMs ?? a.mtimeMs);
      if (added !== 0) return added;
      return a.name.localeCompare(b.name);
    });
    const keeper = sorted[0];
    const keeperRef = { id: fileId(keeper.path), name: keeper.name };
    for (const extra of sorted.slice(1)) extras.set(extra.path, keeperRef);
  }
  return extras;
}

async function walk(root: string, signal: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    throwIfAborted(signal);
    const dir = stack.pop();
    if (!dir) break;
    let dirEntries;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".app") || entry.name.endsWith(".bundle")) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const real = await realpath(full);
        if (real !== root && !real.startsWith(root + sep)) continue;
        out.push(real);
      } catch {
        out.push(full);
      }
    }
  }
  return out;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Scan cancelled");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
