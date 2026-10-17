const SCREENSHOT_PREFIXES = [
  "screenshot",
  "screen shot",
  "screencapture",
  "attached_image",
  "bildschirmfoto",
];

const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".tif",
  ".tiff",
  ".avif",
]);

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"]);
const INSTALLER_EXT = new Set([".dmg", ".pkg", ".exe"]);
const DOCUMENT_EXT = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".csv",
  ".xls",
  ".xlsx",
  ".json",
  ".html",
  ".htm",
  ".md",
  ".markdown",
  ".txt",
  ".rtf",
  ".ppt",
  ".pptx",
]);

export function isScreenshotName(name: string): boolean {
  const lower = name.toLowerCase();
  return SCREENSHOT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function isImageExt(ext: string): boolean {
  return IMAGE_EXT.has(ext.toLowerCase());
}

export function isVideoExt(ext: string): boolean {
  return VIDEO_EXT.has(ext.toLowerCase());
}

export function isInstallerExt(ext: string): boolean {
  return INSTALLER_EXT.has(ext.toLowerCase());
}

export function isDocumentExt(ext: string): boolean {
  return DOCUMENT_EXT.has(ext.toLowerCase());
}

export function normalizeAppToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, " ")
    .replace(/\d+(?:\.\d+)*/g, " ")
    .replace(/\b(arm64|aarch64|x64|x86_64|universal|mac|osx|darwin|setup|installer|intel)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0] ?? "";
}

export function matchInstalledApp(fileName: string, apps: string[]): string | null {
  const fileToken = normalizeAppToken(fileName);
  if (fileToken.length < 3) return null;
  for (const app of apps) {
    if (normalizeAppToken(app) === fileToken) return app;
  }
  return null;
}
