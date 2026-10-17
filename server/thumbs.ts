import { execFile } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { thumbDir } from "./db.ts";

const execFileAsync = promisify(execFile);

export async function ensureThumb(id: string, source: string, mtimeMs: number): Promise<boolean> {
  const directory = thumbDir();
  const output = join(directory, `${id}.jpg`);
  const stamp = join(directory, `${id}.mtime`);
  try {
    const existing = await readFile(stamp, "utf8");
    if (Number(existing) === mtimeMs) {
      await access(output);
      return true;
    }
  } catch {
    // Regenerating is the normal path.
  }
  await rm(output, { force: true });
  await execFileAsync(
    "sips",
    ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "240", source, "--out", output],
    { timeout: 20_000 },
  );
  await writeFile(stamp, String(mtimeMs));
  return true;
}

export function thumbPath(id: string): string {
  return join(thumbDir(), `${id}.jpg`);
}
