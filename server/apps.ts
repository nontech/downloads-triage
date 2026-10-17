import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchInstalledApp } from "../shared/signals.ts";

export async function installedAppNames(): Promise<string[]> {
  const names: string[] = [];
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".app")) names.push(entry.slice(0, -".app".length));
    }
  }
  return names;
}

export function appForInstaller(fileName: string, apps: string[]): string | null {
  return matchInstalledApp(fileName, apps);
}
