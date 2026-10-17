import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import { SAMPLE_CHAR_LIMIT } from "../shared/types.ts";

const execFileAsync = promisify(execFile);
const PDF_LIMIT = 25 * 1024 * 1024;
const SHEET_LIMIT = 20 * 1024 * 1024;

export async function textSample(filePath: string, ext: string, size: number): Promise<string | null> {
  try {
    const lower = ext.toLowerCase();
    if (lower === ".pdf") return await pdfSample(filePath, size);
    if (lower === ".csv") return prefix("CSV header: ", await firstLine(filePath));
    if (lower === ".xlsx" || lower === ".xls") return await sheetSample(filePath, size);
    if (lower === ".json") return jsonSample(await readChunk(filePath, 16_000));
    if (lower === ".html" || lower === ".htm") return htmlSample(await readChunk(filePath, 12_000));
    if (lower === ".md" || lower === ".markdown" || lower === ".txt") {
      return clip(await readChunk(filePath, SAMPLE_CHAR_LIMIT + 200));
    }
    if (lower === ".docx" || lower === ".doc" || lower === ".rtf" || lower === ".ppt" || lower === ".pptx") {
      return await textutilSample(filePath);
    }
    if (!lower) return plainUnknown(filePath);
    return null;
  } catch {
    return null;
  }
}

async function pdfSample(filePath: string, size: number): Promise<string | null> {
  if (size > PDF_LIMIT) return null;
  const { extractText, getDocumentProxy } = await import("unpdf");
  const bytes = new Uint8Array(await readFile(filePath));
  const pdf = await getDocumentProxy(bytes);
  try {
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(extracted.text) ? extracted.text : [String(extracted.text ?? "")];
    return clip(pages.slice(0, 2).join("\n"));
  } finally {
    const closable = pdf as { destroy?: () => Promise<void> | void };
    await closable.destroy?.();
  }
}

async function sheetSample(filePath: string, size: number): Promise<string | null> {
  if (size > SHEET_LIMIT) return null;
  const XLSX = await import("xlsx");
  const book = XLSX.readFile(filePath, { sheetRows: 1, cellDates: false });
  const name = book.SheetNames[0];
  if (!name) return null;
  const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(book.Sheets[name], {
    header: 1,
    blankrows: false,
  });
  const header = (rows[0] ?? []).map((cell) => String(cell ?? "").trim()).filter(Boolean);
  if (!header.length) return null;
  return prefix("Spreadsheet columns: ", header.join(", "));
}

async function textutilSample(filePath: string): Promise<string | null> {
  const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", filePath], {
    maxBuffer: 1024 * 1024,
    timeout: 20_000,
  });
  return clip(stdout);
}

async function plainUnknown(filePath: string): Promise<string | null> {
  const chunk = await readChunk(filePath, 4_000);
  if (!chunk || !looksLikeText(chunk)) return null;
  const keys = jsonSample(chunk);
  return keys || clip(chunk);
}

function jsonSample(text: string): string | null {
  const start = text.indexOf("{");
  const window = start >= 0 ? text.slice(start, start + 4_000) : text.slice(0, 4_000);
  const keys: string[] = [];
  const pattern = /"([^"\\]{1,80})"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(window)) && keys.length < 40) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  if (!keys.length) return null;
  return prefix("JSON keys: ", keys.join(", "));
}

function htmlSample(text: string): string | null {
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clip(stripped);
}

async function firstLine(filePath: string): Promise<string> {
  return (await readChunk(filePath, 8_000)).split(/\r?\n/, 1)[0] ?? "";
}

async function readChunk(filePath: string, bytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function looksLikeText(text: string): boolean {
  const sample = text.slice(0, 512);
  if (sample.includes("\u0000")) return false;
  let weird = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) weird += 1;
  }
  return weird / Math.max(sample.length, 1) < 0.1;
}

function clip(text: string): string | null {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, SAMPLE_CHAR_LIMIT);
}

function prefix(label: string, text: string): string | null {
  const clipped = clip(text);
  if (!clipped) return null;
  return `${label}${clipped}`.slice(0, SAMPLE_CHAR_LIMIT);
}

export function extensionOf(filePath: string): string {
  return extname(filePath).toLowerCase();
}
