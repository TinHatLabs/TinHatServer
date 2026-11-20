// filePick.ts — open the system file picker from code (12.1.17). The <input type=file> stays IN the document from the
// moment it opens until it reports (change) or the picker is closed (cancel). iOS WebKit (the Tin Hat iPhone app and
// Safari) drops a pick from Photos made through an input that isn't in the document: the chat background's second
// "Your own image…" delivered nothing on an iPhone, and in the simulator 4 of 4 Photos picks through a detached input
// were lost while an in-document one delivered every pick. Pickers written as JSX (<input type="file" hidden>, e.g.
// the composer, Memories' Add photos) already live in the document; code that makes one calls this instead
// (filePick.test.ts refuses a detached one anywhere in src/).

export interface PickOptions {
  /** the input's accept list (MIME types and/or .extensions) */
  accept: string;
  multiple?: boolean;
  /** the picker's title where the platform shows one */
  title?: string;
}

/** The open request: a newer one supersedes it (its callback is never called after that, review round). */
let active: { dead: boolean; el: HTMLInputElement } | null = null;

/** Open the picker; `onFiles` gets the chosen files (never called for a cancel, an empty pick, or once superseded or
 *  disposed). Call it from the click / key handler itself (the browser opens a picker only in answer to the person's
 *  own gesture). Returns a disposer (a sheet that closes: its pick is dropped, the input leaves). */
export function pickFiles(opts: PickOptions, onFiles: (files: File[]) => void): () => void {
  // one at a time: the system pickers are modal, so a picker still open when the next one is asked for has gone without
  // a word (no cancel event on an older WebKit): its request is superseded and its input leaves
  if (active) {
    active.dead = true;
    active.el.remove();
  }
  for (const old of Array.from(document.querySelectorAll("input[data-file-pick]"))) old.remove();
  const inp = document.createElement("input");
  const req = { dead: false, el: inp };
  active = req;
  const end = () => {
    req.dead = true;
    inp.remove();
    if (active === req) active = null;
  };
  inp.type = "file";
  inp.accept = opts.accept;
  if (opts.multiple) inp.multiple = true;
  if (opts.title) inp.title = opts.title;
  inp.hidden = true;
  inp.setAttribute("data-file-pick", "");
  inp.addEventListener("change", () => {
    if (req.dead) return;
    const files = Array.from(inp.files ?? []);
    end();
    if (files.length) onFiles(files);
  });
  inp.addEventListener("cancel", end);
  document.body.append(inp);
  inp.click();
  return end;
}
