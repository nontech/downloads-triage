import assert from "node:assert/strict";
import { buildTriage } from "./group.ts";
import { matchInstalledApp } from "./signals.ts";
import type { FileRecord, JevResult } from "./types.ts";

function file(partial: Partial<FileRecord> & Pick<FileRecord, "id" | "name" | "rule">): FileRecord {
  return {
    path: `/Users/mukesh/Downloads/${partial.name}`,
    ext: partial.ext ?? "",
    size: 1000,
    mtimeMs: 1,
    addedMs: Date.UTC(2026, 1, 26),
    lastUsedMs: null,
    whereFrom: null,
    ageDays: 200,
    isImage: false,
    duplicateOfName: null,
    installedApp: null,
    textSample: null,
    sampleSent: false,
    jev: null,
    jevSkippedReason: null,
    ...partial,
  };
}

function jev(partial: Partial<JevResult> & Pick<JevResult, "kind">): JevResult {
  return {
    kindConfidence: 0.92,
    sensitive: 0.05,
    loss: 0.2,
    ...partial,
  };
}

const shot = file({
  id: "shot",
  name: "Screenshot 2026-02-26 at 15.52.26.png",
  rule: "screenshot",
  ext: ".png",
  size: 599 * 1024,
  isImage: true,
  ageDays: 230,
});

const recent = file({
  id: "recent",
  name: "Screenshot 2026-10-16 at 09.00.00.png",
  rule: "screenshot",
  ext: ".png",
  isImage: true,
  ageDays: 1,
  addedMs: Date.UTC(2026, 9, 16),
});

const installer = file({
  id: "loom",
  name: "Loom-0.369.2-arm64.dmg",
  rule: "installer",
  ext: ".dmg",
  size: 218 * 1024 * 1024,
  installedApp: "Loom",
});

const duplicate = file({
  id: "dup",
  name: "Guide copy.pdf",
  rule: "duplicate",
  ext: ".pdf",
  size: 174 * 1024 * 1024,
  duplicateOfName: "Guide.pdf",
});

const video = file({
  id: "video",
  name: "lecture.mp4",
  rule: "large-video",
  ext: ".mp4",
  size: 4.2 * 1024 * 1024 * 1024,
});

const invoice = file({
  id: "invoice",
  name: "February invoice.pdf",
  rule: "document",
  ext: ".pdf",
  textSample: "Invoice total 200",
  sampleSent: true,
  jev: jev({ kind: "invoice", sensitive: 0.9, loss: 2.4 }),
});

const disposable = file({
  id: "disp",
  name: "handout.pdf",
  rule: "document",
  ext: ".pdf",
  textSample: "Welcome to the meetup",
  sampleSent: true,
  jev: jev({ kind: "disposable_download" }),
});

const unsure = file({
  id: "unsure",
  name: "notes.pdf",
  rule: "document",
  ext: ".pdf",
  textSample: "some notes",
  sampleSent: true,
  jev: jev({ kind: "other", kindConfidence: 0.41 }),
});

const noKey = file({
  id: "nokey",
  name: "brief.pdf",
  rule: "document",
  ext: ".pdf",
  jevSkippedReason: "Jev is not configured, so this document was not classified. Left in Review.",
});

const photo = file({
  id: "photo",
  name: "LOTR-close-deals.jpg",
  rule: "plain",
  ext: ".jpg",
  isImage: true,
});

const triage = buildTriage(
  [shot, recent, installer, duplicate, video, invoice, disposable, unsure, noKey, photo],
  30,
);

function view(id: string) {
  const found = triage.views.find((item) => item.file.id === id);
  assert.ok(found, id);
  return found;
}

assert.equal(view("shot").pile, "trash");
assert.equal(view("shot").groupId, "old-screenshots");
assert.equal(
  view("shot").reason,
  "Screenshot from 26 Feb 2026, 599 KB, not opened since download.",
);

assert.equal(view("recent").pile, "keep");
assert.equal(view("recent").groupId, "recent-screenshots");

assert.equal(view("loom").pile, "trash");
assert.match(view("loom").reason, /Disk image, 218 MB\. Loom is already in Applications/);

assert.equal(view("dup").pile, "trash");
assert.match(view("dup").reason, /Exact copy of Guide\.pdf/);

assert.equal(view("video").pile, "review");
assert.equal(view("video").groupId, "large-videos");

assert.equal(view("invoice").pile, "review");
assert.equal(view("invoice").groupId, "sensitive-docs");
assert.match(view("invoice").reason, /invoice or customer export/);

assert.equal(view("disp").pile, "trash");
assert.equal(view("disp").groupId, "disposable");

assert.equal(view("unsure").pile, "review");
assert.equal(view("unsure").groupId, "uncertain");

assert.equal(view("nokey").pile, "review");
assert.equal(view("nokey").groupId, "unconfigured");
assert.match(view("nokey").reason, /not configured/);

assert.equal(view("photo").pile, "keep");
assert.equal(view("photo").groupId, "other");

const moved = buildTriage([shot], 365);
assert.equal(moved.views[0].pile, "keep");
assert.equal(moved.views[0].groupId, "recent-screenshots");

assert.equal(matchInstalledApp("Loom-0.369.2-arm64.dmg", ["Safari", "Loom"]), "Loom");
assert.equal(matchInstalledApp("Archive.zip", ["Arc"]), null);
assert.equal(matchInstalledApp("Telegram Desktop 7.2.9.dmg", ["Telegram Desktop"]), "Telegram Desktop");

console.log("group tests ok");
