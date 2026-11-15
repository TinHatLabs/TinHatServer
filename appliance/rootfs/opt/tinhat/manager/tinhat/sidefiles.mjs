// sidefiles.mjs — the web app's pre-compressed copies, made on the box (websides.py runs this with Node from the box's
// own tinhat/api image: no network, read-only web folder, one writable output folder).
//
// stdin: {"jobs": [{"rel": "assets/index-x.js", "mode": "make", "out": "w7.br"},
//                  {"rel": "assets/index-y.js", "mode": "check", "out": "h8.br"}]}
//   make:  brotli (quality 11) of /web/<rel> into /out/<out>, then read back from disk, decoded and compared with
//          /web/<rel> as read; nothing printed for it unless all of that holds
//   check: /out/<out> (a side file websides.py moved out of the web folder) decoded and compared with /web/<rel>
// stdout: one JSON line per job, only once its file is complete and checked:
//   {"rel", "out", "ok": true, "src": sha256 of the file it matches, "side": sha256 of the brotli file}
//   {"rel", "out", "ok": false, "why": "..."}
// websides.py installs a copy only if, under its lock, the file and the copy still have exactly these sha256s.
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import zlib from "node:zlib";

// the container's mounts; tests run it with plain Node on two folders of their own
const WEB = process.env.SIDEFILES_WEB || "/web";
const OUT = process.env.SIDEFILES_OUT || "/out";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const TEXT = /\.(m?js|css|html|svg|json)$/;
const SAFE = /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/;
const job = JSON.parse(readFileSync(0, "utf8"));
for (const j of job.jobs || []) {
  const say = (o) => process.stdout.write(JSON.stringify({ rel: j.rel, out: j.out, ...o }) + "\n");
  try {
    if (!SAFE.test(j.rel) || j.rel.split("/").includes("..") || !/^[hw]\d+\.br$/.test(j.out)) { say({ ok: false, why: "bad job" }); continue; }
    const src = readFileSync(`${WEB}/${j.rel}`);
    const out = `${OUT}/${j.out}`;
    if (j.mode === "make") {
      const br = zlib.brotliCompressSync(src, { params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: src.length,
        [zlib.constants.BROTLI_PARAM_MODE]: TEXT.test(j.rel) ? zlib.constants.BROTLI_MODE_TEXT : zlib.constants.BROTLI_MODE_GENERIC,
      } });
      if (br.length >= src.length) { say({ ok: false, why: "no smaller" }); continue; }
      writeFileSync(out, br);
      const fd = openSync(out, "r+"); fsyncSync(fd); closeSync(fd);
    } else if (j.mode !== "check") { say({ ok: false, why: "bad mode" }); continue; }
    const side = readFileSync(out); // what is on disk now, not what was meant to be written
    let back;
    try { back = zlib.brotliDecompressSync(side); } catch { say({ ok: false, why: "doesn't decode" }); continue; }
    if (!back.equals(src)) { say({ ok: false, why: "decodes to something else" }); continue; }
    say({ ok: true, src: sha(src), side: sha(side) });
  } catch (e) {
    say({ ok: false, why: String(e && e.code || e).slice(0, 80) });
  }
}
