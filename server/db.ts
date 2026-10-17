import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type JournalItem = {
  originalPath: string;
  trashPath: string;
  name: string;
};

export type JournalEntry = {
  id: number;
  createdAt: number;
  items: JournalItem[];
};

export function supportDir(): string {
  return join(homedir(), "Library", "Application Support", "downloads-triage");
}

export function thumbDir(): string {
  return join(supportDir(), "thumbs");
}

export class Store {
  private db: DatabaseSync;

  constructor(dir = supportDir()) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "thumbs"), { recursive: true });
    this.db = new DatabaseSync(join(dir, "triage.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS keeps (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        decided_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        undone_at INTEGER,
        items_json TEXT NOT NULL
      );
    `);
  }

  keptMatch(path: string, size: number, mtimeMs: number): { decidedAt: number } | null {
    const row = this.db
      .prepare("SELECT size, mtime_ms, decided_at FROM keeps WHERE path = ?")
      .get(path) as { size: number; mtime_ms: number; decided_at: number } | undefined;
    if (!row || row.size !== size || row.mtime_ms !== mtimeMs) return null;
    return { decidedAt: row.decided_at };
  }

  forget(paths: string[]): number {
    const statement = this.db.prepare("DELETE FROM keeps WHERE path = ?");
    let removed = 0;
    this.db.exec("BEGIN");
    try {
      for (const path of paths) removed += Number(statement.run(path).changes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }

  keep(files: { path: string; size: number; mtimeMs: number }[]): void {
    const statement = this.db.prepare(`
      INSERT INTO keeps (path, size, mtime_ms, decided_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        decided_at = excluded.decided_at
    `);
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      for (const file of files) statement.run(file.path, file.size, file.mtimeMs, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  addJournal(items: JournalItem[]): number {
    const result = this.db
      .prepare("INSERT INTO journal (created_at, items_json) VALUES (?, ?)")
      .run(Date.now(), JSON.stringify(items));
    return Number(result.lastInsertRowid);
  }

  latestJournal(): JournalEntry | null {
    const row = this.db
      .prepare(
        "SELECT id, created_at, items_json FROM journal WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get() as { id: number; created_at: number; items_json: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      createdAt: row.created_at,
      items: JSON.parse(row.items_json) as JournalItem[],
    };
  }

  markUndone(id: number): void {
    this.db.prepare("UPDATE journal SET undone_at = ? WHERE id = ?").run(Date.now(), id);
  }
}
