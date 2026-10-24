// ImportDialog.tsx — THEMES-UI.md §6: paste / drop / choose a theme file → importTheme → a preview (the card at 1.5×,
// a Name field, the format, the adjusted note) → Save to My themes (+ use). Refusals in plain words (text.ts).
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { importTheme, slugify, MAX_IMPORT_BYTES, type ImportFormat } from "@/theme/import";
import type { Theme } from "@/theme/engine";
import { Button, Dialog, HintLabel, InlineMessage, TextArea, TextField, showToast, useIsMobile } from "@/ui";
import { resolveColours } from "@/ui/themes";
import { chooseTheme, newMyThemeId, saveMyTheme } from "@/ui/themeStore";
import { ThemeCard } from "./ThemeCard";
import { FORMAT_NAMES, READS, adjustedText, refusalText } from "./text";
import t from "./themes.module.css";

export interface ImportSeed {
  text?: string;
  fileName?: string;
}

type Parsed = { ok: true; theme: Theme; format: ImportFormat; adjusted: number; variant: "dark" | "light" } | { ok: false; error: string } | null;

function parse(text: string, fileName?: string): Parsed {
  if (!text.trim()) return null;
  const r = importTheme(text, fileName);
  if (!r.ok) return { ok: false, error: r.error };
  // the full resolve (roles + every token) — a Tin Hat theme file can carry token overrides the roles alone don't show
  const c = resolveColours(r.theme);
  if ("error" in c) return { ok: false, error: c.error };
  return { ok: true, theme: r.theme, format: r.format, adjusted: c.adjusted.length, variant: c.variant };
}

/** Read a dropped / chosen file as text; a file over 256 KB is not read at all (THEMES-UI §6.1 import-too-large). */
export async function readThemeFile(f: File): Promise<ImportSeed & { tooLarge?: boolean }> {
  if (f.size > MAX_IMPORT_BYTES) return { text: "", fileName: f.name, tooLarge: true };
  return { text: await f.text(), fileName: f.name };
}

export function ImportDialog({ open, seed, onClose }: { open: boolean; seed: (ImportSeed & { tooLarge?: boolean }) | null; onClose: () => void }) {
  const mobile = useIsMobile();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [debounced, setDebounced] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setText(seed?.text ?? "");
    setDebounced(seed?.text ?? "");
    setFileName(seed?.fileName);
    setTooLarge(!!seed?.tooLarge);
    setName("");
    setNameTouched(false);
    setSaveError(null);
  }, [open, seed]);

  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(text), 150);
    return () => window.clearTimeout(h);
  }, [text]);

  const parsed = useMemo<Parsed>(() => (tooLarge ? { ok: false, error: "import-too-large" } : parse(debounced, fileName)), [debounced, fileName, tooLarge]);
  useEffect(() => {
    if (parsed?.ok && !nameTouched) setName(parsed.theme.name);
  }, [parsed, nameTouched]);

  const cleanName = name.trim();
  const nameOk = cleanName.length > 0 && [...cleanName].length <= 80;
  const canSave = !!parsed?.ok && nameOk;

  const save = (use: boolean) => {
    if (!parsed?.ok || !nameOk) return;
    const id = newMyThemeId(slugify(cleanName) || "theme");
    const doc: Theme = { ...parsed.theme, id, name: cleanName };
    const r = saveMyTheme(doc);
    if (r !== "saved" && r !== "noop") {
      setSaveError(refusalText(r));
      return;
    }
    if (use) chooseTheme(doc, { inSettings: true });
    showToast(`${cleanName} saved to My themes`, "short");
    onClose();
  };

  const takeFile = async (f: File | undefined | null) => {
    if (!f) return;
    const s = await readThemeFile(f);
    setText(s.text ?? "");
    setDebounced(s.text ?? "");
    setFileName(s.fileName);
    setTooLarge(!!s.tooLarge);
    setNameTouched(false);
  };
  const onDrag = (e: DragEvent, on: boolean) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    setDrag(on);
  };

  const previewDoc = parsed?.ok ? { ...parsed.theme, name: cleanName || parsed.theme.name } : null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import a theme"
      width={mobile ? "100%" : 560}
      closeOnOutside={false}
      buttons={[
        { text: "Cancel", role: "reject", onClick: onClose },
        { text: "Save to My themes", role: "action", disabled: !canSave, onClick: () => save(false) },
        {
          text: "Save and use",
          role: "accept",
          disabled: !canSave,
          onClick: () => save(true),
          render: (p) => <Button text="Save and use" highlighted disabled={p.disabled} onClick={p.onClick} />,
        },
      ]}
    >
      <div
        className={t.importBody}
        onDragEnter={(e) => onDrag(e, true)}
        onDragOver={(e) => onDrag(e, true)}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDrag(false);
        }}
        onDrop={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setDrag(false);
          void takeFile(e.dataTransfer.files?.[0]);
        }}
      >
        <HintLabel>
          {mobile ? "Paste a theme or choose a file. " : "Paste a theme, drop a file here, or choose one. "}
          {READS}
        </HintLabel>
        <TextArea
          className={t.importText}
          value={text}
          autoGrow={false}
          rows={8}
          placeholder="Paste the theme here…"
          aria-label="Theme text"
          onChange={(e) => {
            setText(e.target.value);
            setFileName(undefined);
            setTooLarge(false);
          }}
        />
        <div className={t.fileRow}>
          <Button text="Choose file…" icon="document-open-symbolic" onClick={() => fileInput.current?.click()} />
          {fileName && <span className={t.fileName}>{fileName}</span>}
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={(e) => {
              void takeFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        {parsed && !parsed.ok && <InlineMessage type="error" text={refusalText(parsed.error)} />}
        {saveError && <InlineMessage type="error" text={saveError} />}
        {parsed?.ok && previewDoc && (
          <div className={t.preview}>
            <div className={t.previewCard}>
              <div className={t.previewInner}>
                <ThemeCard doc={previewDoc} active={false} onPick={() => {}} tabIndex={-1} />
              </div>
            </div>
            <div className={t.previewCol}>
              <label className={t.fieldLabel} htmlFor="theme-import-name">
                Name
              </label>
              <TextField
                id="theme-import-name"
                value={name}
                maxLength={80}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
              <span className={t.meta}>
                {FORMAT_NAMES[parsed.format]} theme · {parsed.variant === "light" ? "Light" : "Dark"}
              </span>
              {parsed.adjusted > 0 && <span className={t.meta}>{adjustedText(parsed.adjusted)}</span>}
            </div>
          </div>
        )}
        {drag && (
          <div className={t.drop}>
            <span>Drop the theme file to import it</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
