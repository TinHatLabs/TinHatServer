// The G9 test's stand-in for psql where none is installed (test_play_g9.py, PLAY_TEST_PG_MODULE = the `pg` package's
// path): SQL on stdin, `-v name=value` like psql, `:'name'` replaced by a quoted literal exactly as psql does (single
// quotes doubled), every statement in one simple query; prints the last result's rows `a|b|c` (psql -At). Connects
// with PGHOST / PGPORT / PGUSER / PGDATABASE from the environment.
const { default: pg } = await import(process.env.PLAY_TEST_PG_MODULE);
const vars = {};
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) if (a[i] === "-v") { const [k, ...v] = a[++i].split("="); vars[k] = v.join("="); }
let sql = "";
for await (const chunk of process.stdin) sql += chunk;
sql = sql.replace(/:'([A-Za-z_][A-Za-z0-9_]*)'/g, (m, k) => (k in vars ? `'${vars[k].replaceAll("'", "''")}'` : m));
const c = new pg.Client();
await c.connect();
try {
    const r = await c.query({ text: sql, rowMode: "array" }); // arrays: a UNION's unnamed columns would collide as keys
    const last = Array.isArray(r) ? r[r.length - 1] : r;
    for (const row of last?.rows || []) console.log(row.map((v) => (v === null ? "" : String(v))).join("|"));
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await c.end(); }
