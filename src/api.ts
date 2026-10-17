import type { Progress, ScanResult } from "../shared/types.ts";

export type UndoInfo = { available: boolean; count: number; createdAt: number | null };

export type FileRef = { path: string; size: number; mtimeMs: number };

export async function streamScan(
  onProgress: (progress: Progress) => void,
  signal: AbortSignal,
): Promise<ScanResult> {
  const response = await fetch("/api/scan", { method: "POST", signal });
  if (!response.ok || !response.body) throw new Error("Scan failed to start");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ScanResult | null = null;
  let failure: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data) as unknown;
      if (event === "progress") onProgress(payload as Progress);
      if (event === "result") result = payload as ScanResult;
      if (event === "error") failure = (payload as { message: string }).message;
    }
  }

  if (failure) throw new Error(failure);
  if (!result) throw new Error("Scan ended before a result");
  return result;
}

export async function trashFiles(files: FileRef[]) {
  return postJson("/api/trash", { files }) as Promise<{
    journalId: number | null;
    moved: { originalPath: string }[];
    failed: { path: string; error: string }[];
  }>;
}

export async function keepFiles(files: FileRef[]) {
  return postJson("/api/keep", { files }) as Promise<{
    kept: number;
    failed: { path: string; error: string }[];
  }>;
}

export async function unkeepFiles(paths: string[]) {
  return postJson("/api/unkeep", { paths }) as Promise<{ removed: number }>;
}

export async function undoLast() {
  return postJson("/api/undo", {}) as Promise<{
    restored: number;
    failed: { original: string; error?: string }[];
  }>;
}

export async function undoInfo(): Promise<UndoInfo> {
  const response = await fetch("/api/undo");
  if (!response.ok) return { available: false, count: 0, createdAt: null };
  return (await response.json()) as UndoInfo;
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Request failed");
  return payload;
}
