import assert from "node:assert/strict";
import { parseMdls } from "./mdls.ts";

const parsed = parseMdls(`kMDItemContentType  = "com.adobe.pdf"
kMDItemDateAdded    = 2026-07-27 12:43:36 PM +0000
kMDItemLastUsedDate = (null)
kMDItemWhereFroms   = (
    "https://app.slack.com/",
    "https://other.example/"
)
`);

assert.equal(parsed.contentType, "com.adobe.pdf");
assert.equal(new Date(parsed.addedMs ?? 0).toISOString(), "2026-07-27T12:43:36.000Z");
assert.equal(parsed.lastUsedMs, null);
assert.equal(parsed.whereFrom, "https://app.slack.com/");

const narrow = parseMdls("kMDItemDateAdded    = 2026-07-27 3:05:56\u202fPM +0000\n");
assert.equal(new Date(narrow.addedMs ?? 0).toISOString(), "2026-07-27T15:05:56.000Z");

console.log("metadata tests ok");
