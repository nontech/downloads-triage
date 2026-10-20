export type Rule =
  | "duplicate"
  | "large-video"
  | "screenshot"
  | "installer"
  | "document"
  | "plain";

export type Pile = "trash" | "review" | "keep";

export type JevKind =
  | "invoice"
  | "customer_or_financial_data"
  | "work_document"
  | "personal_reference"
  | "disposable_download"
  | "other";

export type JevResult = {
  kind: JevKind;
  kindConfidence: number;
  sensitive: number;
  loss: number;
};

export type FileRecord = {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  addedMs: number;
  lastUsedMs: number | null;
  whereFrom: string | null;
  ageDays: number;
  rule: Rule;
  isImage: boolean;
  duplicateOfId: string | null;
  duplicateOfName: string | null;
  userKept: boolean;
  installedApp: string | null;
  textSample: string | null;
  sampleSent: boolean;
  jev: JevResult | null;
  jevSkippedReason: string | null;
};

export type Chip = { label: string; value: string };

export type FileView = {
  file: FileRecord;
  pile: Pile;
  groupId: string;
  reason: string;
  chips: Chip[];
};

export type Group = {
  id: string;
  pile: Pile;
  title: string;
  reason: string;
  fileIds: string[];
  bytes: number;
};

export type ProgressPhase =
  | "listing"
  | "metadata"
  | "duplicates"
  | "thumbnails"
  | "classifying"
  | "done";

export type Progress = {
  phase: ProgressPhase;
  done: number;
  total: number;
  detail: string;
};

export type KeptFile = {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  decidedAt: number;
  isImage: boolean;
};

export type ScanResult = {
  files: FileRecord[];
  kept: KeptFile[];
  hiddenCount: number;
  jevConfigured: boolean;
  jevKeyRejected: boolean;
  downloadsPath: string;
  scannedAt: number;
};

export const LARGE_VIDEO_BYTES = 500 * 1024 * 1024;
export const SAMPLE_CHAR_LIMIT = 1500;
