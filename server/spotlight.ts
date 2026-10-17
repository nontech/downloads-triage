import { execFile } from "node:child_process";
import { parseMdls } from "./mdls.ts";

export type SpotlightMeta = {
  contentType: string | null;
  addedMs: number | null;
  lastUsedMs: number | null;
  whereFrom: string | null;
};

const EMPTY: SpotlightMeta = {
  contentType: null,
  addedMs: null,
  lastUsedMs: null,
  whereFrom: null,
};

export function readSpotlight(filePath: string): Promise<SpotlightMeta> {
  return new Promise((resolve) => {
    execFile(
      "mdls",
      [
        "-name",
        "kMDItemWhereFroms",
        "-name",
        "kMDItemLastUsedDate",
        "-name",
        "kMDItemDateAdded",
        "-name",
        "kMDItemContentType",
        filePath,
      ],
      { timeout: 20_000 },
      (error, stdout) => {
        if (error) {
          resolve(EMPTY);
          return;
        }
        resolve(parseMdls(stdout));
      },
    );
  });
}
