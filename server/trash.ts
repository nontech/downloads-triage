import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Moved = { original: string; trashPath: string | null; error?: string };
type Restored = { original: string; ok: boolean; error?: string };

const TRASH_SCRIPT = `
function run(argv) {
  const paths = JSON.parse(argv[0]);
  const Finder = Application("Finder");
  const moved = [];
  for (const p of paths) {
    try {
      const item = Finder.delete(Path(p));
      moved.push({ original: p, trashPath: pathFromItem(item) });
    } catch (error) {
      moved.push({ original: p, trashPath: null, error: String(error) });
    }
  }
  return JSON.stringify(moved);
}
function pathFromItem(item) {
  const url = String(item.url());
  if (!url.startsWith("file://")) throw new Error("Finder did not return a file URL");
  return decodeURIComponent(url.slice("file://".length));
}
`;

const RESTORE_SCRIPT = `
function run(argv) {
  const items = JSON.parse(argv[0]);
  const Finder = Application("Finder");
  const results = [];
  for (const item of items) {
    try {
      Finder.move(Path(item.trashPath), { to: Path(item.originalDir) });
      results.push({ original: item.originalPath, ok: true });
    } catch (error) {
      results.push({ original: item.originalPath, ok: false, error: String(error) });
    }
  }
  return JSON.stringify(results);
}
`;

export async function moveToTrash(paths: string[]): Promise<Moved[]> {
  const moved: Moved[] = [];
  for (let i = 0; i < paths.length; i += 40) {
    const batch = paths.slice(i, i + 40);
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", TRASH_SCRIPT, JSON.stringify(batch)], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    moved.push(...(JSON.parse(stdout) as Moved[]));
  }
  return moved;
}

export async function restoreFromTrash(
  items: { originalPath: string; trashPath: string; originalDir: string }[],
): Promise<Restored[]> {
  const restored: Restored[] = [];
  for (let i = 0; i < items.length; i += 40) {
    const batch = items.slice(i, i + 40);
    const { stdout } = await execFileAsync(
      "osascript",
      ["-l", "JavaScript", "-e", RESTORE_SCRIPT, JSON.stringify(batch)],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    restored.push(...(JSON.parse(stdout) as Restored[]));
  }
  return restored;
}
