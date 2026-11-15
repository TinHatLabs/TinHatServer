// noteicon.ts — the sender's picture for a message notification (Messages-style, sun-winnotify 2026-11-14).
// The page posts its notifications through the service worker registration whenever there is one (Reply / Mark as
// read need it), and the browser's notification service can't read a page `blob:` URL (core/notes.ts drops it, so
// every web toast showed the app icon). A small `data:` URL it CAN read: the 96×96 crop the server makes is a few KB.
// The classic `new Notification` path (no worker) keeps the cheaper object URL.

/** Largest picture sent as a data: URL (bytes); a bigger one falls back to the app icon. */
export const NOTE_ICON_MAX_BYTES = 64 * 1024;

/** How the picture travels: "data" (worker path, size-capped image), "blob" (classic path), or none. */
export function noteIconKind(worker: boolean, type: string, size: number): "data" | "blob" | null {
  if (!type.startsWith("image/") || size <= 0) return null;
  if (!worker) return "blob";
  return size <= NOTE_ICON_MAX_BYTES ? "data" : null;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The notification icon for a fetched avatar: a data: URL (worker), an object URL (classic) or undefined. */
export async function noteIcon(blob: Blob, worker: boolean): Promise<string | undefined> {
  const kind = noteIconKind(worker, blob.type, blob.size);
  if (kind === "blob") return URL.createObjectURL(blob);
  if (kind === "data") return `data:${blob.type};base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
  return undefined;
}
