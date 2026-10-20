import { chipsFor, filePile, fileReason } from "./decide.ts";
import { formatBytes } from "./format.ts";
import type { FileRecord, FileView, Group, Pile } from "./types.ts";

const GROUP_ORDER = [
  "old-screenshots",
  "installers",
  "duplicates",
  "disposable",
  "large-videos",
  "sensitive-docs",
  "unconfigured",
  "uncertain",
  "recent-screenshots",
  "kept-documents",
  "left-by-you",
  "other",
] as const;

type GroupId = (typeof GROUP_ORDER)[number];

const TITLES: Record<GroupId, string> = {
  "old-screenshots": "Old screenshots",
  installers: "Installers",
  duplicates: "Exact duplicates",
  disposable: "Disposable downloads",
  "large-videos": "Large videos",
  "sensitive-docs": "Invoices and customer data",
  unconfigured: "Documents waiting on Jev",
  uncertain: "Uncertain",
  "recent-screenshots": "Recent screenshots",
  "kept-documents": "Documents to keep",
  "left-by-you": "You left these here",
  other: "Other files",
};

export function buildTriage(files: FileRecord[], screenshotAgeDays: number): {
  views: FileView[];
  groups: Group[];
} {
  const views = files.map((file) => {
    const pile = filePile(file, screenshotAgeDays);
    const groupId = groupFor(file, pile);
    return {
      file,
      pile,
      groupId,
      reason: fileReason(file),
      chips: chipsFor(file),
    };
  });

  const buckets = new Map<GroupId, FileView[]>();
  for (const view of views) {
    const id = view.groupId as GroupId;
    const list = buckets.get(id);
    if (list) list.push(view);
    else buckets.set(id, [view]);
  }

  const groups: Group[] = [];
  for (const id of GROUP_ORDER) {
    const members = buckets.get(id);
    if (!members?.length) continue;
    members.sort((a, b) => b.file.size - a.file.size || a.file.name.localeCompare(b.file.name));
    const bytes = members.reduce((sum, view) => sum + view.file.size, 0);
    groups.push({
      id,
      pile: members[0].pile,
      title: TITLES[id],
      reason: groupReason(id, members, bytes, screenshotAgeDays),
      fileIds: members.map((view) => view.file.id),
      bytes,
    });
  }

  return { views, groups };
}

function groupFor(file: FileRecord, pile: Pile): GroupId {
  if (file.userKept) return "left-by-you";
  switch (file.rule) {
    case "duplicate":
      return "duplicates";
    case "installer":
      return "installers";
    case "large-video":
      return "large-videos";
    case "screenshot":
      return pile === "trash" ? "old-screenshots" : "recent-screenshots";
    case "document":
      if (pile === "trash") return "disposable";
      if (pile === "keep") return "kept-documents";
      if (file.jev && (file.jev.kind === "invoice" || file.jev.kind === "customer_or_financial_data" || file.jev.sensitive > 0.7)) {
        return "sensitive-docs";
      }
      if (!file.jev && file.jevSkippedReason?.includes("not configured")) return "unconfigured";
      return "uncertain";
    default:
      return "other";
  }
}

function groupReason(id: GroupId, members: FileView[], bytes: number, ageDays: number): string {
  const count = members.length;
  const size = formatBytes(bytes);
  switch (id) {
    case "old-screenshots":
      return `${count} ${noun(count, "screenshot")} older than ${ageDays} days, ${size}. Uncheck any you still want.`;
    case "installers": {
      const matched = members.filter((view) => view.file.installedApp).length;
      return matched
        ? `${count} ${noun(count, "installer")}, ${size}. ${matched} match ${noun(matched, "app")} already on this Mac.`
        : `${count} ${noun(count, "installer")}, ${size}. These can usually be downloaded again.`;
    }
    case "duplicates":
      return `Older copies, ${size}. Each newest copy is marked Stays and is not selected for trash.`;
    case "disposable":
      return `Documents Jev classified as safe to delete, ${size}.`;
    case "large-videos":
      return `Large ${noun(count, "video")}, ${size}. ${count === 1 ? "It stays" : "They stay"} in Review because deleting one is a different decision from deleting a screenshot.`;
    case "sensitive-docs":
      return "Invoices, exports, and other files that look sensitive. They are not part of suggested trash.";
    case "unconfigured":
      return "These documents were not sent to Jev because no key is saved. They stay in Review.";
    case "uncertain":
      return "Jev was unsure, the file could not be read, or losing it looked costly.";
    case "recent-screenshots":
      return `Screenshots from the last ${ageDays} days.`;
    case "kept-documents":
      return "Documents that look worth keeping in Downloads.";
    case "left-by-you":
      return "You already chose to leave these in Downloads. They stay in this section.";
    default:
      return "Nothing suggested these should be deleted.";
  }
}

function noun(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

export function groupsByPile(groups: Group[]): Record<Pile, Group[]> {
  return {
    trash: groups.filter((group) => group.pile === "trash"),
    review: groups.filter((group) => group.pile === "review"),
    keep: groups.filter((group) => group.pile === "keep"),
  };
}
