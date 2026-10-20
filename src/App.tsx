import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TriageMenuState } from "./bridge.ts";
import { keepFiles, streamScan, trashFiles, undoInfo, undoLast, type UndoInfo } from "./api.ts";
import { formatBytes } from "../shared/format.ts";
import { buildTriage, groupsByPile } from "../shared/group.ts";
import type { FileRecord, FileView, Group, Pile, Progress, ScanResult } from "../shared/types.ts";

const PILE_COPY: Record<Pile, { title: string; lede: string }> = {
  trash: {
    title: "Suggested trash",
    lede: "Checked by default. Nothing moves until you confirm.",
  },
  review: {
    title: "Review",
    lede: "Not suggested for a bulk delete. Check a file only if you mean to trash it.",
  },
  keep: {
    title: "Keep in Downloads",
    lede: "Stays in Downloads. Nothing here is suggested for trash.",
  },
};

export function App() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ageDays, setAgeDays] = useState(30);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Pile>("trash");
  const [gridGroups, setGridGroups] = useState<Set<string>>(new Set());
  const [emptied, setEmptied] = useState<Group[]>([]);
  const seenGroups = useRef<Group[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<UndoInfo>({ available: false, count: 0, createdAt: null });
  const scanAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    void refreshUndo();
    void runScan();
    return () => scanAbort.current?.abort();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const triage = useMemo(
    () => (result ? buildTriage(result.files, ageDays) : null),
    [result, ageDays],
  );
  const piles = triage ? groupsByPile(triage.groups) : null;

  useEffect(() => {
    if (!triage || !result) return;
    const live = new Set(triage.groups.map((group) => group.id));
    const present = new Set(result.files.map((file) => file.id));
    const gone = seenGroups.current
      .filter((group) => !live.has(group.id) && group.fileIds.length > 0 && group.fileIds.every((id) => !present.has(id)))
      .map((group) => ({ ...group, fileIds: [], bytes: 0, reason: "Nothing left in this section." }));
    setEmptied((prev) => {
      const ids = new Set(prev.map((group) => group.id));
      return [...prev.filter((group) => !live.has(group.id)), ...gone.filter((group) => !ids.has(group.id))];
    });
    seenGroups.current = triage.groups;
  }, [triage, result]);
  const openView = triage?.views.find((view) => view.file.id === openId) ?? null;

  const selected = triage?.views.filter((view) => checked.has(view.file.id)) ?? [];
  const selectedBytes = selected.reduce((sum, view) => sum + view.file.size, 0);
  const selectedTrash = selected.filter((view) => view.pile === "trash").length;
  const selectedReview = selected.filter((view) => view.pile === "review").length;
  const selectedKeep = selected.filter((view) => view.pile === "keep").length;

  async function refreshUndo() {
    setUndo(await undoInfo());
  }

  async function runScan() {
    scanAbort.current?.abort();
    const controller = new AbortController();
    scanAbort.current = controller;
    setError(null);
    setNotice(null);
    setProgress({ phase: "listing", done: 0, total: 0, detail: "Listing Downloads" });
    setOpenId(null);
    seenGroups.current = [];
    setEmptied([]);
    try {
      const next = await streamScan(setProgress, controller.signal);
      setResult(next);
      const initial = buildTriage(next.files, ageDays);
      setChecked(new Set(initial.views.filter((view) => view.pile === "trash").map((view) => view.file.id)));
      setExpanded(new Set(initial.groups.filter((group) => group.fileIds.length <= 6).map((group) => group.id)));
      setProgress(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setProgress(null);
      setError(err instanceof Error ? err.message : "Scan failed");
    }
  }

  function changeAge(next: number) {
    setAgeDays(next);
    setChecked((prev) => {
      const updated = new Set(prev);
      for (const file of result?.files ?? []) {
        if (file.rule !== "screenshot") continue;
        if (file.ageDays >= next) updated.add(file.id);
        else updated.delete(file.id);
      }
      return updated;
    });
  }

  function toggle(id: string, on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleGroup(ids: string[], on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function trashSelection(files: FileRecord[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await trashFiles(files.map(refOf));
      const gone = new Set(response.moved.map((item) => item.originalPath));
      dropFiles(gone, false);
      await refreshUndo();
      const failed = response.failed.length ? ` ${response.failed.length} could not be moved.` : "";
      setNotice(`Moved ${response.moved.length} ${response.moved.length === 1 ? "file" : "files"} to Trash.${failed}`);
      if (openId && files.some((file) => file.id === openId && gone.has(file.path))) setOpenId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move files to Trash");
    } finally {
      setBusy(false);
    }
  }

  async function keepSelection(files: FileRecord[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await keepFiles(files.map(refOf));
      const paths = new Set(files.map((file) => file.path));
      if (response.failed.length) {
        for (const failure of response.failed) paths.delete(failure.path);
      }
      dropFiles(paths, true);
      const failed = response.failed.length ? ` ${response.failed.length} could not be marked.` : "";
      setNotice(`Left ${response.kept} ${response.kept === 1 ? "file" : "files"} in Downloads. ${failed}`);
      if (openId && files.some((file) => file.id === openId && paths.has(file.path))) setOpenId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark files as kept");
    } finally {
      setBusy(false);
    }
  }

  function dropFiles(paths: Set<string>, leave: boolean) {
    setResult((current) => {
      if (!current) return current;
      const removedIds = current.files.filter((file) => paths.has(file.path)).map((file) => file.id);
      setChecked((prev) => {
        const next = new Set(prev);
        for (const id of removedIds) next.delete(id);
        return next;
      });
      return {
        ...current,
        files: leave
          ? current.files.map((file) => (paths.has(file.path) ? { ...file, userKept: true } : file))
          : current.files.filter((file) => !paths.has(file.path)),
      };
    });
  }

  async function undoTrash() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await undoLast();
      await refreshUndo();
      const failed = response.failed.length ? ` ${response.failed.length} could not be restored.` : "";
      await runScan();
      setNotice(`Restored ${response.restored} ${response.restored === 1 ? "file" : "files"} from Trash.${failed}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Undo failed");
    } finally {
      setBusy(false);
    }
  }

  const actionsRef = useRef<{
    scan: () => void;
    showPile: (pile: Pile) => void;
    trash: () => void;
    undo: () => void;
  }>({
    scan: () => void runScan(),
    showPile: (pile) => setTab(pile),
    trash: () => void trashSelection(selected.map((view) => view.file)),
    undo: () => void undoTrash(),
  });
  actionsRef.current = {
    scan: runScan,
    showPile: (pile: Pile) => setTab(pile),
    trash: () => void trashSelection(selected.map((view) => view.file)),
    undo: () => void undoTrash(),
  };

  useEffect(() => {
    window.__triage = {
      scan: () => void actionsRef.current.scan(),
      showPile: (pile) => {
        if (pile === "trash" || pile === "review" || pile === "keep") actionsRef.current.showPile(pile);
      },
      trash: () => actionsRef.current.trash(),
      undo: () => void actionsRef.current.undo(),
    };
  }, []);

  useEffect(() => {
    const state: TriageMenuState = {
      scanning: progress !== null || busy,
      canTrash: selected.length > 0 && !busy && progress === null,
      canUndo: undo.available && !busy && progress === null,
      pile: tab,
    };
    window.webkit?.messageHandlers?.triage?.postMessage(state);
  }, [progress, busy, selected.length, undo.available, tab]);

  function openSettings() {
    window.webkit?.messageHandlers?.triage?.postMessage({ openSettings: true });
  }

  const scannedCount = result?.files.length ?? 0;

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="kicker">Local triage</p>
          <h1>Downloads</h1>
          {result && (
            <p className="stats">Scanned {scannedCount} {scannedCount === 1 ? "file" : "files"} in Downloads.</p>
          )}
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => void runScan()} disabled={busy || progress !== null}>
            Rescan
          </button>
          <button type="button" data-testid="undo" onClick={() => void undoTrash()} disabled={!undo.available || busy}>
            Undo last trash{undo.available ? ` (${undo.count})` : ""}
          </button>
        </div>
      </header>

      {result?.jevKeyRejected && (
        <p className="banner">
          That Jev key was rejected. Documents were left in Review.
          <button type="button" className="banner-action" onClick={openSettings}>
            Open Settings
          </button>
        </p>
      )}
      {result && !result.jevConfigured && (
        <p className="banner">
          Jev is not configured. Add your key in Settings, then rescan.
          Screenshots, installers, duplicates, and large videos are still grouped.
        </p>
      )}
      {notice && <p className="toast">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {progress && (
        <section className="progress" data-testid="scan-progress" aria-busy="true">
          <p className="kicker">Reading Downloads</p>
          <h2>{progress.detail}</h2>
          <div className="track">
            <div style={{ width: progress.total ? `${Math.min(100, (progress.done / progress.total) * 100)}%` : "12%" }} />
          </div>
          <p className="stats">
            {progress.total ? `${progress.done} / ${progress.total}` : "Starting"}
          </p>
        </section>
      )}

      {result && triage && piles && (
        <>
          <div className="tabs" role="tablist" aria-label="File piles">
            {(["trash", "review", "keep"] as const).map((pile) => {
              const count = piles[pile].reduce((sum, group) => sum + group.fileIds.length, 0);
              const bytes = piles[pile].reduce((sum, group) => sum + group.bytes, 0);
              return (
                <button
                  key={pile}
                  type="button"
                  role="tab"
                  aria-selected={tab === pile}
                  className={`tab ${pile} ${tab === pile ? "on" : ""}`}
                  onClick={() => setTab(pile)}
                >
                  <span>{PILE_COPY[pile].title}</span>
                  <small>
                    {count} {count === 1 ? "file" : "files"} · {formatBytes(bytes)}
                  </small>
                </button>
              );
            })}
          </div>

          {tab === "trash" && (
            <label className="slider">
              <span>Screenshots older than {ageDays} days are suggested for trash</span>
              <input
                type="range"
                min={7}
                max={365}
                value={ageDays}
                onChange={(event) => changeAge(Number(event.target.value))}
              />
            </label>
          )}

          <PileSection
            pile={tab}
            groups={[...piles[tab], ...emptied.filter((group) => group.pile === tab)]}
            views={triage.views}
            checked={checked}
            expanded={expanded}
            onToggleExpanded={(id) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onToggle={toggle}
            onToggleGroup={toggleGroup}
            gridGroups={gridGroups}
            onLayout={(id, layout) =>
              setGridGroups((prev) => {
                const next = new Set(prev);
                if (layout === "grid") next.add(id);
                else next.delete(id);
                return next;
              })
            }
            onOpen={setOpenId}
            onKeep={(file) => void keepSelection([file])}
          />
        </>
      )}

      <div className="bar">
        <p className="bar-eq">
          <span>{selectedTrash} Suggested trash</span>
          <span className="op">+</span>
          <span>{selectedReview} Review</span>
          <span className="op">+</span>
          <span>{selectedKeep} Keep in Downloads</span>
          <span className="op">=</span>
          <strong>
            {selected.length} {selected.length === 1 ? "file" : "files"} {formatBytes(selectedBytes)}
          </strong>
        </p>
        <button
          type="button"
          className="danger"
          disabled={selected.length === 0 || busy}
          onClick={() => void trashSelection(selected.map((view) => view.file))}
        >
          Move to Trash
        </button>
      </div>

      {openView && (
        <div className="drawer-backdrop" onClick={() => setOpenId(null)}>
          <aside className="drawer" data-testid="drawer" onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{openView.file.name}</h2>
              <button type="button" onClick={() => setOpenId(null)}>
                Close
              </button>
            </header>
            <p className="reason">{openView.reason}</p>
            <dl>
              {openView.chips.map((chip) => (
                <div key={chip.label}>
                  <dt>{chip.label}</dt>
                  <dd>{chip.value}</dd>
                </div>
              ))}
            </dl>
            <h3>Text sample sent to Jev</h3>
            <pre>{openView.file.sampleSent && openView.file.textSample ? openView.file.textSample : "Not sent to Jev."}</pre>
            <p className="path">{openView.file.path}</p>
            <div className="drawer-actions">
              <button
                type="button"
                className="danger"
                data-testid="trash-one"
                disabled={busy}
                onClick={() => void trashSelection([openView.file])}
              >
                Move to Trash
              </button>
              <button type="button" disabled={busy} onClick={() => void keepSelection([openView.file])}>
                Keep in Downloads
              </button>
            </div>
</aside>
        </div>
      )}
      <a className="watermark" href="https://builtbymukesh.com">
        Built by Mukesh in Berlin
      </a>
    </div>
  );
}

function PreviewLine({
  role,
  file,
  onOpen,
}: {
  role?: "Stays" | "Older";
  file: Pick<FileRecord, "id" | "name" | "ext" | "isImage">;
  onOpen?: (id: string) => void;
}) {
  const body = (
    <>
      {role && <span className={`role ${role === "Stays" ? "stays" : ""}`}>{role}</span>}
      <span className="preview-face">
        <FileFace file={file} />
      </span>
      <span className="preview-name">{readableName(file.name)}</span>
    </>
  );
  if (!file.id || !onOpen) return <div className="preview-row with-role">{body}</div>;
  return (
    <button type="button" className={`preview-row ${role ? "with-role" : ""}`} title={file.name} onClick={() => onOpen(file.id)}>
      {body}
    </button>
  );
}

function readableName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "");
  return stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function FileFace({ file }: { file: { id: string; ext: string; isImage: boolean; name: string } }) {
  const [broken, setBroken] = useState(false);
  if (file.isImage && !broken) {
    return <img src={`/thumbs/${file.id}`} alt="" onError={() => setBroken(true)} />;
  }
  return <FileGlyph ext={file.ext} name={file.name} />;
}

function FileGlyph({ ext, name }: { ext: string; name: string }) {
  const kind = glyphKind(ext, name);
  return (
    <span className={`glyph ${kind.tone}`} aria-hidden="true">
      {kind.label}
    </span>
  );
}

function glyphKind(ext: string, name: string): { label: string; tone: string } {
  const value = ext.toLowerCase();
  if (value === ".pdf") return { label: "PDF", tone: "pdf" };
  if (value === ".dmg" || value === ".pkg" || value === ".exe") return { label: value.slice(1, 4).toUpperCase(), tone: "installer" };
  if ([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"].includes(value)) return { label: "VID", tone: "video" };
  if ([".zip", ".gz", ".tgz", ".rar", ".7z"].includes(value)) return { label: "ZIP", tone: "archive" };
  if ([".doc", ".docx", ".rtf", ".pages"].includes(value)) return { label: "DOC", tone: "doc" };
  if ([".xls", ".xlsx", ".csv", ".numbers"].includes(value)) return { label: "CSV", tone: "sheet" };
  if ([".ppt", ".pptx", ".key"].includes(value)) return { label: "PPT", tone: "deck" };
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"].includes(value)) return { label: "IMG", tone: "image" };
  const letters = (value.replace(".", "") || name).slice(0, 3).toUpperCase();
  return { label: letters || "FILE", tone: "file" };
}

function refOf(file: FileRecord) {
  return { path: file.path, size: file.size, mtimeMs: file.mtimeMs };
}

function PileSection({
  pile,
  groups,
  views,
  checked,
  expanded,
  onToggleExpanded,
  onToggle,
  onToggleGroup,
  gridGroups,
  onLayout,
  onOpen,
  onKeep,
  extra,
}: {
  pile: Pile;
  groups: Group[];
  views: ReturnType<typeof buildTriage>["views"];
  checked: Set<string>;
  expanded: Set<string>;
  onToggleExpanded: (id: string) => void;
  onToggle: (id: string, on: boolean) => void;
  onToggleGroup: (ids: string[], on: boolean) => void;
  gridGroups: Set<string>;
  onLayout: (id: string, layout: "list" | "grid") => void;
  onOpen: (id: string) => void;
  onKeep: (file: FileRecord) => void;
  extra?: ReactNode;
}) {
  const count = groups.reduce((sum, group) => sum + group.fileIds.length, 0);
  const bytes = groups.reduce((sum, group) => sum + group.bytes, 0);
  return (
    <section className={`screen ${pile}`}>
      <header className="pile-intro">
        <div>
          <h2>{PILE_COPY[pile].title}</h2>
          <p>{PILE_COPY[pile].lede}</p>
        </div>
        <div className="intro-side">
          <span>
            {count} {count === 1 ? "file" : "files"} · {formatBytes(bytes)}
          </span>
          {extra}
        </div>
      </header>
      <div className="groups">
      {groups.length === 0 && <p className="empty">Nothing in this section.</p>}
      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          views={views}
          checked={checked}
          expanded={expanded.has(group.id)}
          onToggleExpanded={() => onToggleExpanded(group.id)}
          onToggle={onToggle}
          onToggleGroup={onToggleGroup}
          layout={gridGroups.has(group.id) ? "grid" : "list"}
          onLayout={(layout) => onLayout(group.id, layout)}
          onOpen={onOpen}
          onKeep={onKeep}
        />
      ))}
      </div>
    </section>
  );
}

function ClosedPreview({
  groupId,
  members,
  views,
  onOpen,
  onExpand,
}: {
  groupId: string;
  members: FileView[];
  views: FileView[];
  onOpen: (id: string) => void;
  onExpand: () => void;
}) {
  if (!members.length) return null;
  if (groupId === "duplicates") return <DuplicatePreview members={members} views={views} onOpen={onOpen} onExpand={onExpand} />;
  const shown = members.slice(0, 5);
  const rest = members.length - shown.length;
  return (
    <ul className="preview-list">
      {shown.map((view) => (
        <li key={view.file.id}>
          <PreviewLine file={view.file} onOpen={onOpen} />
        </li>
      ))}
      {rest > 0 && (
        <li>
          <button type="button" className="more-names" onClick={onExpand}>
            +{rest} more
          </button>
        </li>
      )}
    </ul>
  );
}

function DuplicatePreview({
  members,
  views,
  onOpen,
  onExpand,
}: {
  members: FileView[];
  views: FileView[];
  onOpen: (id: string) => void;
  onExpand: () => void;
}) {
  const clusters = new Map<string, FileView[]>();
  for (const member of members) {
    const key = member.file.duplicateOfId ?? member.file.duplicateOfName ?? member.file.id;
    const list = clusters.get(key);
    if (list) list.push(member);
    else clusters.set(key, [member]);
  }
  const shown = [...clusters.entries()].slice(0, 3);
  const shownCount = shown.reduce((sum, [, extras]) => sum + extras.length, 0);
  const rest = members.length - shownCount;
  return (
    <div className="preview-list">
      {shown.map(([key, extras]) => {
        const sample = extras[0].file;
        const keeper =
          views.find((view) => view.file.id === sample.duplicateOfId) ??
          views.find((view) => view.file.name === sample.duplicateOfName && view.file.rule !== "duplicate");
        return (
          <div className="pair" key={key}>
            {keeper ? (
              <PreviewLine role="Stays" file={keeper.file} onOpen={onOpen} />
            ) : (
              <PreviewLine
                role="Stays"
                file={{
                  id: "",
                  name: sample.duplicateOfName ?? "Newest copy",
                  ext: sample.ext,
                  isImage: false,
                }}
              />
            )}
            {extras.slice(0, 2).map((extra) => (
              <PreviewLine key={extra.file.id} role="Older" file={extra.file} onOpen={onOpen} />
            ))}
            {extras.length > 2 && (
              <button type="button" className="more-names" onClick={onExpand}>
                +{extras.length - 2} older copies of this file
              </button>
            )}
          </div>
        );
      })}
      {rest > 0 && (
        <button type="button" className="more-names" onClick={onExpand}>
          +{rest} more older copies
        </button>
      )}
    </div>
  );
}

function duplicateClusters(members: FileView[], views: FileView[]) {
  const clusters = new Map<string, FileView[]>();
  for (const member of members) {
    const key = member.file.duplicateOfId ?? member.file.duplicateOfName ?? member.file.id;
    const list = clusters.get(key);
    if (list) list.push(member);
    else clusters.set(key, [member]);
  }
  return [...clusters.entries()].map(([key, extras]) => {
    const sample = extras[0].file;
    const keeper =
      views.find((view) => view.file.id === sample.duplicateOfId) ??
      views.find((view) => view.file.name === sample.duplicateOfName && view.file.rule !== "duplicate");
    return { key, keeper, extras };
  });
}

function DuplicateGrid({
  members,
  views,
  expanded,
  checked,
  onToggle,
  onOpen,
  onKeep,
  onExpand,
}: {
  members: FileView[];
  views: FileView[];
  expanded: boolean;
  checked: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onOpen: (id: string) => void;
  onKeep: (file: FileRecord) => void;
  onExpand: () => void;
}) {
  const clusters = duplicateClusters(members, views);
  const shown = expanded ? clusters : clusters.slice(0, 2);
  const shownOld = shown.reduce((sum, cluster) => sum + (expanded ? cluster.extras.length : Math.min(1, cluster.extras.length)), 0);
  const rest = members.length - shownOld;
  return (
    <>
      <div className="pair-grid">
        {shown.map((cluster) => (
          <div className="duo" key={cluster.key}>
            <div>
              <span className="role stays">Stays</span>
              {cluster.keeper ? (
                <PairTile file={cluster.keeper.file} onOpen={onOpen} />
              ) : (
                <PairTile
                  file={{
                    id: "",
                    name: cluster.extras[0].file.duplicateOfName ?? "Newest copy",
                    ext: cluster.extras[0].file.ext,
                    isImage: false,
                  }}
                />
              )}
            </div>
            {(expanded ? cluster.extras : cluster.extras.slice(0, 1)).map((extra) => (
              <div key={extra.file.id}>
                <span className="role">Older</span>
                <PairTile
                  file={extra.file}
                  controls={expanded}
                  checked={checked.has(extra.file.id)}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onKeep={onKeep}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      {!expanded && rest > 0 && (
        <button type="button" className="more-names" onClick={onExpand}>
          +{rest} more
        </button>
      )}
    </>
  );
}

function PairTile({
  file,
  controls,
  checked,
  onToggle,
  onOpen,
  onKeep,
}: {
  file: Pick<FileRecord, "id" | "name" | "ext" | "isImage">;
  controls?: boolean;
  checked?: boolean;
  onToggle?: (id: string, on: boolean) => void;
  onOpen?: (id: string) => void;
  onKeep?: (file: FileRecord) => void;
}) {
  return (
    <article className={`tile ${controls ? "" : "quiet"} ${controls && checked ? "on" : ""}`}>
      {controls && onToggle && onKeep && "path" in file && (
        <div className="tile-tools">
          <input
            type="checkbox"
            className="tile-check"
            checked={Boolean(checked)}
            aria-label={file.name}
            onChange={(event) => onToggle(file.id, event.target.checked)}
          />
          <button type="button" className="keep-mini" onClick={() => onKeep(file as FileRecord)}>
            Keep
          </button>
        </div>
      )}
      <button type="button" className="tile-body" title={file.name} disabled={!file.id} onClick={() => file.id && onOpen?.(file.id)}>
        {file.isImage && file.id ? (
          <img src={`/thumbs/${file.id}`} alt="" />
        ) : (
          <span className="tile-copy">
            <span className="tile-ext">{file.ext.replace(".", "").toUpperCase() || "FILE"}</span>
            <span className="tile-name">{readableName(file.name)}</span>
          </span>
        )}
      </button>
    </article>
  );
}

function GroupCard({
  group,
  views,
  checked,
  expanded,
  onToggleExpanded,
  onToggle,
  onToggleGroup,
  layout,
  onLayout,
  onOpen,
  onKeep,
}: {
  group: Group;
  views: ReturnType<typeof buildTriage>["views"];
  checked: Set<string>;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggle: (id: string, on: boolean) => void;
  onToggleGroup: (ids: string[], on: boolean) => void;
  layout: "list" | "grid";
  onLayout: (layout: "list" | "grid") => void;
  onOpen: (id: string) => void;
  onKeep: (file: FileRecord) => void;
}) {
  const members = group.fileIds
    .map((id) => views.find((view) => view.file.id === id))
    .filter((view): view is NonNullable<typeof view> => Boolean(view));
  const selected = members.filter((view) => checked.has(view.file.id)).length;
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = selected > 0 && selected < members.length;
  }, [selected, members.length]);

  return (
    <article className="card" data-testid={`group-${group.id}`}>
      <header>
        <div className="card-row">
          <input
            ref={box}
            type="checkbox"
            checked={members.length > 0 && selected === members.length}
            aria-label={`Select ${group.title}`}
            onChange={(event) => onToggleGroup(group.fileIds, event.target.checked)}
          />
          <h3>{group.title}</h3>
          <div className="card-actions">
            <span className="meta">
              {members.length} · {formatBytes(group.bytes)}
            </span>
            <div className="layout-switch" role="group" aria-label={`${group.title} layout`}>
              <button type="button" className={layout === "list" ? "on" : ""} onClick={() => onLayout("list")}>
                List
              </button>
              <button type="button" className={layout === "grid" ? "on" : ""} onClick={() => onLayout("grid")}>
                Grid
              </button>
            </div>
            <button type="button" className="expand" onClick={onToggleExpanded}>
              {expanded ? "Hide" : "Show all"}
            </button>
          </div>
        </div>
        <p className="card-reason">{group.reason}</p>
      </header>
      {layout === "grid" ? (
        group.id === "duplicates" ? (
          <DuplicateGrid
            members={members}
            views={views}
            expanded={expanded}
            checked={checked}
            onToggle={onToggle}
            onOpen={onOpen}
            onKeep={onKeep}
            onExpand={onToggleExpanded}
          />
        ) : (
        <>
      {!expanded && (
        <>
          <div className="file-grid">{renderTiles(members.slice(0, 5), false)}</div>
          {members.length > 5 && (
            <button type="button" className="more-names" onClick={onToggleExpanded}>
              +{members.length - 5} more
            </button>
          )}
        </>
      )}
      {expanded && <div className="file-grid">{renderTiles(members, true)}</div>}
        </>
        )
      ) : (
        <>
      {!expanded && (
        <ClosedPreview groupId={group.id} members={members} views={views} onOpen={onOpen} onExpand={onToggleExpanded} />
      )}
      {expanded && group.id === "duplicates" && (
        <div className="dup-list">
          {duplicateClusters(members, views).map((cluster) => (
            <div className="dup-block" key={cluster.key}>
              <div className="dup-stay">
                <span className="role stays">Stays</span>
                <span>{cluster.keeper ? cluster.keeper.file.name : cluster.extras[0].file.duplicateOfName}</span>
              </div>
              {cluster.extras.map((view) => (
                <div className="dup-older" key={view.file.id}>
                  <input
                    type="checkbox"
                    className="list-check"
                    checked={checked.has(view.file.id)}
                    aria-label={view.file.name}
                    onChange={(event) => onToggle(view.file.id, event.target.checked)}
                  />
                  <span className="role">Older</span>
                  <button type="button" className="file-open" onClick={() => onOpen(view.file.id)}>
                    <FileFace file={view.file} />
                    <span>
                      <strong>{view.file.name}</strong>
                      <em>{view.reason}</em>
                    </span>
                  </button>
                  <button type="button" className="quiet" onClick={() => onKeep(view.file)}>
                    Keep
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {expanded && group.id !== "duplicates" && (
        <ul className="files">
          {members.map((view) => (
            <li key={view.file.id} data-name={view.file.name}>
              <input
                type="checkbox"
                className="list-check"
                checked={checked.has(view.file.id)}
                aria-label={view.file.name}
                onChange={(event) => onToggle(view.file.id, event.target.checked)}
              />
              <button type="button" className="file-open" onClick={() => onOpen(view.file.id)}>
                <FileFace file={view.file} />
                <span>
                  <strong>{view.file.name}</strong>
                  <em>{view.reason}</em>
                </span>
              </button>
              <button type="button" className="quiet" onClick={() => onKeep(view.file)}>
                Keep
              </button>
            </li>
          ))}
        </ul>
      )}
        </>
      )}
    </article>
  );

  function renderTiles(list: FileView[], controls: boolean) {
    return list.map((view) => (
            <article key={view.file.id} className={`tile ${controls ? "" : "quiet"} ${controls && checked.has(view.file.id) ? "on" : ""}`}>
              {controls && (
              <div className="tile-tools">
                <input
                  type="checkbox"
                  className="tile-check"
                  checked={checked.has(view.file.id)}
                  aria-label={view.file.name}
                  onChange={(event) => onToggle(view.file.id, event.target.checked)}
                />
                <button type="button" className="keep-mini" onClick={() => onKeep(view.file)}>
                  Keep
                </button>
              </div>
              )}
              <button type="button" className="tile-body" title={view.file.name} onClick={() => onOpen(view.file.id)}>
                {view.file.isImage ? (
                  <img src={`/thumbs/${view.file.id}`} alt="" />
                ) : (
                  <span className="tile-copy">
                    <span className="tile-ext">{view.file.ext.replace(".", "").toUpperCase() || "FILE"}</span>
                    <span className="tile-name">{readableName(view.file.name)}</span>
                    {view.file.duplicateOfName && (
                      <span className="tile-ext">Older copy of {readableName(view.file.duplicateOfName)}</span>
                    )}
                  </span>
                )}
              </button>
              {view.file.isImage && (
                <p className="tile-caption">
                  {view.file.duplicateOfName
                    ? `Older copy of ${readableName(view.file.duplicateOfName)}`
                    : readableName(view.file.name)}
                </p>
              )}
            </article>
    ));
  }
}
