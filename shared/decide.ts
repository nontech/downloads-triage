import type { Chip, FileRecord, JevKind, Pile } from "./types.ts";
import { formatBytes, formatDate, dateFromName, percent, sourceLabel } from "./format.ts";

export const LOSS_LABELS = [
  "nothing important",
  "inconvenient",
  "hard to replace",
  "irreplaceable",
] as const;

export const KIND_LABELS: Record<JevKind, string> = {
  invoice: "an invoice",
  customer_or_financial_data: "customer or financial data",
  work_document: "a work document",
  personal_reference: "a personal reference",
  disposable_download: "a disposable download",
  other: "something else",
};

export function lossLabel(score: number): string {
  const index = Math.min(LOSS_LABELS.length - 1, Math.max(0, Math.round(score)));
  return LOSS_LABELS[index];
}

export type Decision = { pile: Pile; reason: string };

export function decideDocument(file: FileRecord): Decision {
  if (!file.jev) {
    return {
      pile: "review",
      reason:
        file.jevSkippedReason ??
        "Jev did not return a decision. Left in Review.",
    };
  }

  const { kind, kindConfidence, sensitive, loss } = file.jev;
  const sensitiveKind = kind === "invoice" || kind === "customer_or_financial_data";

  if (sensitiveKind) {
    return {
      pile: "review",
      reason:
        "Looks like an invoice or customer export. Left in Review so it is not part of a bulk trash.",
    };
  }
  if (sensitive > 0.7) {
    return {
      pile: "review",
      reason: `The sample looks like personal or customer data (${percent(sensitive)}). Left in Review.`,
    };
  }
  if (kindConfidence < 0.6) {
    return {
      pile: "review",
      reason: `Jev was not confident enough to classify this (${percent(kindConfidence)}). Left in Review.`,
    };
  }
  if (loss >= 2) {
    return {
      pile: "review",
      reason: `Losing this looked ${lossLabel(loss)}. Left in Review.`,
    };
  }
  if (!file.textSample) {
    return {
      pile: "review",
      reason: "No text sample was available, so this was not suggested for trash.",
    };
  }
  if (kind === "disposable_download") {
    return {
      pile: "trash",
      reason: `Classified as a disposable download (${percent(kindConfidence)} confident). Loss if deleted: ${lossLabel(loss)}.`,
    };
  }
  return {
    pile: "keep",
    reason: `Classified as ${KIND_LABELS[kind]} (${percent(kindConfidence)} confident). Left in Downloads.`,
  };
}

export function fileReason(file: FileRecord): string {
  if (file.userKept) return "You left this in Downloads.";
  switch (file.rule) {
    case "screenshot":
      return screenshotReason(file);
    case "installer":
      return installerReason(file);
    case "duplicate":
      return `Exact copy of ${file.duplicateOfName ?? "another file"}. Trashing this frees ${formatBytes(file.size)} and the newer copy stays.`;
    case "large-video":
      return `Video, ${formatBytes(file.size)}. This is a unique file, so it stays in Review instead of suggested trash.`;
    case "document":
      return decideDocument(file).reason;
    default:
      return "No rule suggested deleting this.";
  }
}

function screenshotReason(file: FileRecord): string {
  const when = formatDate(dateFromName(file.name) ?? file.addedMs);
  return `Screenshot from ${when}, ${formatBytes(file.size)}, ${openedPhrase(file)}.`;
}

function openedPhrase(file: FileRecord): string {
  if (file.lastUsedMs == null) return "not opened since download";
  if (Math.abs(file.lastUsedMs - file.addedMs) < 2 * 60 * 1000) return "not opened since download";
  return `last opened ${formatDate(file.lastUsedMs)}`;
}

function installerReason(file: FileRecord): string {
  const noun = file.ext === ".dmg" ? "Disk image" : file.ext === ".pkg" ? "Installer package" : "Installer";
  if (file.installedApp) {
    return `${noun}, ${formatBytes(file.size)}. ${file.installedApp} is already in Applications. You can download it again from the vendor.`;
  }
  return `${noun}, ${formatBytes(file.size)}, added ${formatDate(file.addedMs)}. You can download it again from the vendor.`;
}

export function filePile(file: FileRecord, screenshotAgeDays: number): Pile {
  if (file.userKept) return "keep";
  switch (file.rule) {
    case "duplicate":
    case "installer":
      return "trash";
    case "large-video":
      return "review";
    case "screenshot":
      return file.ageDays >= screenshotAgeDays ? "trash" : "keep";
    case "document":
      return decideDocument(file).pile;
    default:
      return "keep";
  }
}

export function chipsFor(file: FileRecord): Chip[] {
  const chips: Chip[] = [
    { label: "Size", value: formatBytes(file.size) },
    { label: "Added", value: formatDate(file.addedMs) },
    { label: "Age", value: file.ageDays === 0 ? "Today" : `${file.ageDays} days` },
    {
      label: "Last opened",
      value: file.lastUsedMs == null ? "Not opened" : formatDate(file.lastUsedMs),
    },
  ];
  if (file.whereFrom) chips.push({ label: "Source", value: sourceLabel(file.whereFrom) });
  if (file.duplicateOfName) chips.push({ label: "Duplicate of", value: file.duplicateOfName });
  if (file.installedApp) chips.push({ label: "Installed app", value: file.installedApp });
  if (file.jev) {
    chips.push({ label: "Kind", value: KIND_LABELS[file.jev.kind] });
    chips.push({ label: "Confidence", value: percent(file.jev.kindConfidence) });
    chips.push({ label: "Sensitive", value: percent(file.jev.sensitive) });
    chips.push({ label: "Loss", value: lossLabel(file.jev.loss) });
  }
  return chips;
}
