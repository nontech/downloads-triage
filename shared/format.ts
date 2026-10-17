export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / 1024 / 1024;
    return mb >= 10 ? `${Math.round(mb)} MB` : `${trimOne(mb)} MB`;
  }
  return `${trimOne(bytes / 1024 / 1024 / 1024)} GB`;
}

function trimOne(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

export function dateFromName(name: string): number | null {
  const match = name.match(/(20\d{2})[-.](\d{2})[-.](\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day);
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function sourceLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value.length > 48 ? `${value.slice(0, 45)}…` : value;
  }
}
