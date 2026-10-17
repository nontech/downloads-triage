export function parseMdls(output: string): {
  contentType: string | null;
  addedMs: number | null;
  lastUsedMs: number | null;
  whereFrom: string | null;
} {
  const fields = new Map<string, string>();
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(kMDItem\w+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value === "(") {
      const parts: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== ")") {
        parts.push(unquote(lines[i].trim()));
        i += 1;
      }
      value = parts.filter(Boolean).join("\n");
    }
    fields.set(match[1], value);
  }

  return {
    contentType: clean(fields.get("kMDItemContentType")),
    addedMs: parseMdlsDate(fields.get("kMDItemDateAdded")),
    lastUsedMs: parseMdlsDate(fields.get("kMDItemLastUsedDate")),
    whereFrom: firstWhereFrom(fields.get("kMDItemWhereFroms")),
  };
}

function unquote(value: string): string {
  const trimmed = value.replace(/,$/, "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

function clean(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = unquote(value.trim());
  if (!trimmed || trimmed === "(null)") return null;
  return trimmed;
}

export function parseMdlsDate(value: string | undefined): number | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const normalized = cleaned.replace(/[\u202f\u00a0]/g, " ");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function firstWhereFrom(value: string | undefined): string | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const first = cleaned.split("\n").map((part) => part.trim()).find(Boolean);
  return first ?? null;
}
