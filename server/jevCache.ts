import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JevKind, JevResult } from "../shared/types.ts";
import { supportDir } from "./db.ts";

const KINDS = new Set<JevKind>([
  "invoice",
  "customer_or_financial_data",
  "work_document",
  "personal_reference",
  "disposable_download",
  "other",
]);

export type CachedJev = {
  name: string;
  size: number;
  jev: JevResult;
  textSample: string | null;
};

export class JevCache {
  private entries = new Map<string, CachedJev>();
  private dirty = false;

  constructor(private filePath = join(supportDir(), "jev-cache.json")) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") return;
      for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = asCached(value);
        if (entry) this.entries.set(path, entry);
      }
    } catch {
      // A missing or unreadable cache means every document is classified once.
    }
  }

  match(path: string, name: string, size: number): CachedJev | null {
    const entry = this.entries.get(path);
    if (!entry || entry.name !== name || entry.size !== size) return null;
    return entry;
  }

  remember(path: string, entry: CachedJev): void {
    this.entries.set(path, entry);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(supportDir(), { recursive: true });
    const body: Record<string, CachedJev> = {};
    for (const [path, entry] of this.entries) body[path] = entry;
    await writeFile(this.filePath, JSON.stringify(body));
    this.dirty = false;
  }
}

function asCached(value: unknown): CachedJev | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<CachedJev> & { jev?: Partial<JevResult> };
  const jev = row.jev;
  if (!jev || typeof row.name !== "string" || typeof row.size !== "number") return null;
  if (typeof jev.kind !== "string" || !KINDS.has(jev.kind as JevKind)) return null;
  if (typeof jev.kindConfidence !== "number" || typeof jev.sensitive !== "number" || typeof jev.loss !== "number") return null;
  return {
    name: row.name,
    size: row.size,
    textSample: typeof row.textSample === "string" ? row.textSample : null,
    jev: {
      kind: jev.kind as JevKind,
      kindConfidence: jev.kindConfidence,
      sensitive: jev.sensitive,
      loss: jev.loss,
    },
  };
}
