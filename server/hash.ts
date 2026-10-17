import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export function sha256File(filePath: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    const fail = (error: Error) => {
      stream.destroy();
      reject(error);
    };
    const onAbort = () => fail(new Error("Scan cancelled"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    stream.on("end", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(hash.digest("hex"));
    });
  });
}
