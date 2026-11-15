// measure.worker.ts — "Match the game" (lane sun-gamebg): the art's bound cells (model.ts boundPixels) off the main
// thread. Full size, every pixel (a 3840×1240 hero is 4.8 MP: a downscale would average away the bright specks the
// contrast gate found). In: {id, src} (a same-origin art url). Out: {id, ok, w, h, cells}.
import { artDimsOk, artSizeOk, boundPixels } from "./model";

self.onmessage = async (e: MessageEvent<{ id: number; src: string }>) => {
  const { id, src } = e.data;
  try {
    const r = await fetch(src, { credentials: "same-origin" });
    if (!r.ok) throw new Error(String(r.status));
    const blob = await r.blob();
    // R3-4: the size from the header first; a picture too large (or of unknown size) is never decoded
    if (!artSizeOk(new Uint8Array(await blob.arrayBuffer()))) throw new Error("size");
    const bmp = await createImageBitmap(blob);
    const w = bmp.width;
    const h = bmp.height;
    if (!artDimsOk(w, h)) {
      bmp.close();
      throw new Error("size");
    }
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("no 2d");
    g.drawImage(bmp, 0, 0);
    bmp.close();
    const cells = boundPixels(g.getImageData(0, 0, w, h).data, w);
    (self as unknown as Worker).postMessage({ id, ok: true, w, h, cells });
  } catch {
    (self as unknown as Worker).postMessage({ id, ok: false });
  }
};
