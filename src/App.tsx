import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepFiles, streamScan, trashFiles, undoInfo, undoLast, unkeepFiles, type UndoInfo } from "./api.ts";
import { formatBytes, formatDate } from "../shared/format.ts";
import { buildTriage, groupsByPile } from "../shared/group.ts";
import type { FileRecord, Group, KeptFile, Pile, Progress, ScanResult } from "../shared/types.ts";

type Screen = Pile | "kept";

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
    title: "Keep",
    lede: "Left in Downloads. Mark them kept to move them into Kept and leave them out of the next scan.",
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
  const [tab, setTab] = useState<Screen>("trash");
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<KeptFile | null>(null);
  const [keptChecked, setKeptChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<UndoInfo>({ available: false, count: 0, createdAt: null });
  const scanAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    void refreshUndo();
    void runScan();
    return () => scanAbort.current?.abort();
  }, []);

  const triage = useMemo(
    () => (result ? buildTriage(result.files, ageDays) : null),
    [result, ageDays],
  );
  const piles = triage ? groupsByPile(triage.groups) : null;
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
      setNotice(`Marked ${response.kept} ${response.kept === 1 ? "file" : "files"} as kept. They stay in Downloads and are listed under Kept.${failed}`);
      if (openId && files.some((file) => file.id === openId && paths.has(file.path))) setOpenId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark files as kept");
    } finally {
      setBusy(false);
    }
  }

  function dropFiles(paths: Set<string>, hide: boolean) {
    setResult((current) =>
      current
        ? {
            ...current,
            files: current.files.filter((file) => !paths.has(file.path)),
            kept: hide
              ? [
                  ...(current.kept ?? []),
                  ...current.files
                    .filter((file) => paths.has(file.path))
                    .map((file) => ({
                      id: file.id,
                      path: file.path,
                      name: file.name,
                      ext: file.ext,
                      size: file.size,
                      mtimeMs: file.mtimeMs,
                      decidedAt: Date.now(),
                      isImage: file.isImage,
                    })),
                ]
              : current.kept,
            hiddenCount:
              current.kept.length + (hide ? current.files.filter((file) => paths.has(file.path)).length : 0),
          }
        : current,
    );
    setChecked((prev) => {
      const next = new Set(prev);
      for (const file of result?.files ?? []) {
        if (paths.has(file.path)) next.delete(file.id);
      }
      return next;
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

  const keptFiles = result?.kept ?? [];
  const keptBytes = keptFiles.reduce((sum, file) => sum + file.size, 0);
  const scannedCount = (result?.files.length ?? 0) + keptFiles.length;

  async function releaseKept(files: KeptFile[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await unkeepFiles(files.map((file) => file.path));
      const paths = new Set(files.map((file) => file.path));
      setResult((current) => {
        if (!current) return current;
        const kept = current.kept.filter((file) => !paths.has(file.path));
        return { ...current, kept, hiddenCount: kept.length };
      });
      setKeptChecked((prev) => {
        const next = new Set(prev);
        for (const file of files) next.delete(file.id);
        return next;
      });
      setNotice(
        `Removed ${response.removed} ${response.removed === 1 ? "file" : "files"} from Kept. Rescan to classify them again.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the keep mark");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="kicker">Local triage</p>
          <h1>Downloads</h1>
          {result && (
            <div className="stats">
              <p>Scanned {scannedCount} {scannedCount === 1 ? "file" : "files"} in Downloads.</p>
              <p>Left out {keptFiles.length} · {formatBytes(keptBytes)} because you marked them Kept.</p>
            </div>
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

      {result && !result.jevConfigured && (
        <p className="banner">
          Jev is not configured. Add <code>TYPESAFE_API_KEY</code> to <code>.env</code> and rescan to classify documents.
          Screenshots, installers, duplicates, and large videos are still grouped.
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}
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
            <button
              type="button"
              role="tab"
              aria-selected={tab === "kept"}
              className={`tab kept ${tab === "kept" ? "on" : ""}`}
              onClick={() => setTab("kept")}
            >
              <span>Kept</span>
              <small>
                {keptFiles.length} {keptFiles.length === 1 ? "file" : "files"} · {formatBytes(keptBytes)}
              </small>
            </button>
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

          {tab === "kept" ? (
            <KeptSection
              files={keptFiles}
              checked={keptChecked}
              busy={busy}
              onChecked={setKeptChecked}
              onPreview={setPreview}
              onRelease={(files) => void releaseKept(files)}
            />
          ) : (
          <PileSection
            pile={tab}
            groups={piles[tab]}
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
            onOpen={setOpenId}
            onKeep={(file) => void keepSelection([file])}
            extra={
              tab === "keep" ? (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || piles.keep.length === 0}
                  onClick={() =>
                    void keepSelection(
                      triage.views.filter((view) => view.pile === "keep").map((view) => view.file),
                    )
                  }
                >
                  Mark all as kept
                </button>
              ) : null
            }
          />
          )}
        </>
      )}

      <div className="bar">
        <p className="bar-eq">
          <span>{selectedTrash} Suggested trash</span>
          <span className="op">+</span>
          <span>{selectedReview} Review</span>
          <span className="op">+</span>
          <span>{selectedKeep} Keep</span>
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

      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}

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
    </div>
  );
}

function KeptSection({
  files,
  checked,
  busy,
  onChecked,
  onPreview,
  onRelease,
}: {
  files: KeptFile[];
  checked: Set<string>;
  busy: boolean;
  onChecked: (next: Set<string>) => void;
  onPreview: (file: KeptFile) => void;
  onRelease: (files: KeptFile[]) => void;
}) {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const sorted = [...files].sort((a, b) => b.decidedAt - a.decidedAt || a.name.localeCompare(b.name));
  const selected = sorted.filter((file) => checked.has(file.id));
  const allOn = sorted.length > 0 && selected.length === sorted.length;
  function toggle(id: string, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    onChecked(next);
  }
  return (
    <section className="screen">
      <header className="pile-intro">
        <div>
          <h2>Kept</h2>
          <p>Still in Downloads. Select the files to include on the next scan. PDFs and images open in a preview.</p>
        </div>
        <div className="intro-side">
          <span>
            {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(bytes)}
          </span>
          <button type="button" className="primary" disabled={busy || selected.length === 0} onClick={() => onRelease(selected)}>
            Include {selected.length === 1 ? "1 selected" : `${selected.length} selected`} on next scan
          </button>
        </div>
      </header>
      <div className="groups">
      {files.length === 0 && <p className="empty">Nothing kept yet.</p>}
      {files.length > 0 && (
        <label className="kept-all">
          <input
            type="checkbox"
            checked={allOn}
            onChange={(event) => onChecked(event.target.checked ? new Set(sorted.map((file) => file.id)) : new Set())}
          />
          Select all
        </label>
      )}
      {sorted.map((file) => {
        const canPreview = file.isImage || file.ext === ".pdf";
        return (
          <div className="kept-row" key={file.path}>
            <input
              type="checkbox"
              checked={checked.has(file.id)}
              aria-label={file.name}
              onChange={(event) => toggle(file.id, event.target.checked)}
            />
            <FileFace file={file} />
            <button
              type="button"
              className="kept-name"
              disabled={!canPreview}
              onClick={() => canPreview && onPreview(file)}
            >
              <strong>{file.name}</strong>
              <p>
                {formatBytes(file.size)} · marked {formatDate(file.decidedAt)}
              </p>
            </button>
          </div>
        );
      })}
      </div>
    </section>
  );
}

function PreviewModal({ file, onClose }: { file: KeptFile; onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="preview" role="dialog" aria-modal="true" aria-label={file.name} onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{file.name}</h2>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </header>
        {file.ext === ".pdf" ? (
          <iframe title={file.name} src={`/api/file/${file.id}`} />
        ) : (
          <img src={`/api/file/${file.id}`} alt={file.name} />
        )}
      </div>
    </div>
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
      {groups.length === 0 && <p className="empty">Nothing in this pile.</p>}
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
          onOpen={onOpen}
          onKeep={onKeep}
        />
      ))}
      </div>
    </section>
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
  onOpen: (id: string) => void;
  onKeep: (file: FileRecord) => void;
}) {
  const members = group.fileIds
    .map((id) => views.find((view) => view.file.id === id))
    .filter((view): view is NonNullable<typeof view> => Boolean(view));
  const pictures = members.filter((view) => view.file.isImage).slice(0, 12);
  const named = members.filter((view) => !view.file.isImage).slice(0, 4);
  const selected = members.filter((view) => checked.has(view.file.id)).length;
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = selected > 0 && selected < members.length;
  }, [selected, members.length]);

  return (
    <article className="card" data-testid={`group-${group.id}`}>
      <header>
        <input
          ref={box}
          type="checkbox"
          checked={members.length > 0 && selected === members.length}
          aria-label={`Select ${group.title}`}
          onChange={(event) => onToggleGroup(group.fileIds, event.target.checked)}
        />
        <div>
          <h3>{group.title}</h3>
          <p>{group.reason}</p>
        </div>
        <span className="meta">
          {members.length} · {formatBytes(group.bytes)}
        </span>
      </header>
      {!expanded && pictures.length > 0 && (
        <div className="thumbs">
          {pictures.map((view) => (
            <button type="button" key={view.file.id} onClick={() => onOpen(view.file.id)} title={view.file.name}>
              <img src={`/thumbs/${view.file.id}`} alt="" />
            </button>
          ))}
          {members.filter((view) => view.file.isImage).length > pictures.length && (
            <span className="more">+{members.filter((view) => view.file.isImage).length - pictures.length}</span>
          )}
        </div>
      )}
      {!expanded && named.length > 0 && (
        <ul className="name-preview">
          {named.map((view) => (
            <li key={view.file.id}>
              <button type="button" onClick={() => onOpen(view.file.id)} title={view.file.name}>
                <span>{readableName(view.file.name)}</span>
                <small>{view.file.ext.replace(".", "").toUpperCase()}</small>
              </button>
            </li>
          ))}
          {members.filter((view) => !view.file.isImage).length > named.length && (
            <li className="more-names">+{members.filter((view) => !view.file.isImage).length - named.length} more</li>
          )}
        </ul>
      )}
      <button type="button" className="expand" onClick={onToggleExpanded}>
        {expanded ? "Hide files" : `Show ${members.length} ${members.length === 1 ? "file" : "files"}`}
      </button>
      {expanded && (
        <ul className="files">
          {members.map((view) => (
            <li key={view.file.id} data-name={view.file.name}>
              <input
                type="checkbox"
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
    </article>
  );
}
