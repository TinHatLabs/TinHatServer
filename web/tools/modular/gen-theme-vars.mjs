#!/usr/bin/env node
// gen-theme-vars.mjs — the web's CSS-variable plumbing for the colour catalogue (Tin Hat modular UI, step 1a).
//
//   tw -w modular node --no-warnings --import ./tools/theme-lib/register.mjs tools/modular/gen-theme-vars.mjs [--check]
//
// Reads src/theme/tokens.json (the roles + element tokens, a byte copy of the contract's: tools/theme-lib/
// sync-contract.mjs) and the built-in themes, resolves OLED and Goose for the WEB (resolveForApp(…, "web"): step-1a
// webPins included) and writes
//   src/ui/themeVars.gen.ts    the typed map id → `--th-*` name (RoleId / TokenId / ThemeColourId) + FLOAT_ALPHA_IDS
//   src/ui/tokenSpec.gen.json  the runtime token spec {tokens: [{id, default, webPin?}]} — tokens.json minus its docs
//                              (~83 KB instead of ~410 KB in the bundle)
//   src/ui/tokens.css          the block between the GENERATED markers: every role/token variable with its OLED web
//                              value (CSS works before JS)
//   index.html                 the block between the GENERATED markers of its <style>: the role/token variables the
//                              static page reads (boot card, page background) for every built-in theme — `:root` =
//                              OLED, `html[data-theme="<name>"]` = the others (the inline script sets data-theme from
//                              the saved pref before the first paint) — and <meta name="theme-color"> = OLED window.bg
// Fails (exit 1) when: two ids get one variable name; a generated name is defined elsewhere in the app and is not a
// registered subtree restyle (lib.mjs SUBTREE_OVERRIDES); a table entry is stale; a `--th-*` name in src/ or index.html
// is neither a role/token variable nor defined in the app (a typo — or a pre-token name like `--th-text` from code
// written before the tokens: it would silently paint nothing; MIGRATING.md §8); with --check, when a generated file is
// not up to date.
import fs from "node:fs";
import { BUILTINS, ROLE_IDS, resolveForApp } from "../../src/theme/engine.ts";
import { cssColour, varName } from "../../src/ui/themeNames.ts";
import { BEGIN, END, FLOAT_ALPHA, GEN_SPEC, GEN_TS, INDEX_HTML, SUBTREE_OVERRIDES, TOKENS_CSS, TOKENS_JSON, abs, readJson, scanVars } from "./lib.mjs";

const check = process.argv.includes("--check");
const errors = [];
const fail = (m) => errors.push(m);

// ---- the catalogue --------------------------------------------------------------------------------------------
const catalogue = readJson(TOKENS_JSON);
if (catalogue.format !== "tinhat-tokens" || catalogue.v !== 1) throw new Error(`${TOKENS_JSON}: not tinhat-tokens v1`);
const roleIds = catalogue.roles.map((r) => r.id);
const tokenIds = catalogue.tokens.map((t) => t.id);
if (roleIds.join() !== [...ROLE_IDS].join()) fail(`${TOKENS_JSON} roles differ from the engine's ROLE_IDS`);

const spec = {
  tokens: catalogue.tokens.map((t) => (t.webPin ? { id: t.id, default: t.default, webPin: t.webPin } : { id: t.id, default: t.default })),
};
const resolved = {};
for (const name of ["oled", "goose"]) {
  const r = resolveForApp(BUILTINS[name], spec, "web");
  if (!r.ok) throw new Error(`engine refused built-in ${name}: ${r.error}`);
  const full = resolveForApp(BUILTINS[name], catalogue, "web");
  if (!full.ok || JSON.stringify(full) !== JSON.stringify(r)) fail(`${GEN_SPEC}: the compact spec does not resolve like ${TOKENS_JSON} (${name})`);
  resolved[name] = { ...r.roles, ...r.tokens };
}

// ---- names ----------------------------------------------------------------------------------------------------
const allIds = [...roleIds, ...tokenIds];
const nameOf = new Map(allIds.map((id) => [id, varName(id)]));
const owner = new Map();
for (const [id, n] of nameOf) {
  if (owner.has(n)) fail(`variable name collision: ${n} = ${owner.get(n)} and ${id}`);
  owner.set(n, id);
}

// ---- float-alpha spelling (lib.mjs FLOAT_ALPHA) -----------------------------------------------------------------------
const FLOAT = new Set(FLOAT_ALPHA);
for (const id of FLOAT_ALPHA) {
  if (!nameOf.has(id)) fail(`lib.mjs FLOAT_ALPHA: unknown id ${id}`);
  else if (!["oled", "goose"].some((t) => resolved[t][id].includes("/"))) fail(`lib.mjs FLOAT_ALPHA: ${id} is opaque in both built-ins — drop it`);
}
const spell = (theme, id) => cssColour(resolved[theme][id], FLOAT.has(id));

// ---- who references what ----------------------------------------------------------------------------------------
const hits = scanVars();
const defs = hits.filter((h) => h.def);
const definedAt = new Map();
for (const h of defs) definedAt.set(h.name, `${h.file}:${h.line}`);

const listed = (table, file, n) => (table[file] ?? []).includes(n);
for (const h of defs) {
  const n = h.name;
  const where = `${h.file}:${h.line}`;
  if (owner.has(n) && !listed(SUBTREE_OVERRIDES, h.file, n))
    fail(`${n} is generated for ${owner.get(n)} but ${where} defines it too (a subtree restyle of a control goes in lib.mjs SUBTREE_OVERRIDES)`);
}
for (const [file, names] of Object.entries(SUBTREE_OVERRIDES)) {
  for (const n of names) if (!defs.some((h) => h.file === file && h.name === n)) fail(`lib.mjs SUBTREE_OVERRIDES: ${file} no longer defines ${n} — drop the entry`);
}
// every `--th-*` the code reads is a role/token variable or a variable the app defines itself (the non-colour ones in
// tokens.css: --th-font, --th-radius, --th-z-* …); anything else paints nothing — a typo, or a pre-token colour name
// (--th-text, --th-panel-hi, --th-accent-rgb …) in code from before the tokens, e.g. a merge from main
for (const h of hits) {
  if (h.def || !h.code) continue;
  const n = h.name;
  if (owner.has(n) || definedAt.has(n)) continue;
  fail(`unknown variable ${n} at ${h.file}:${h.line} (not a role/token variable and not defined in the app — a typo, or a pre-token name: give the site its element token, src/theme/MIGRATING.md §8)`);
}

// ---- outputs ----------------------------------------------------------------------------------------------------
// the role/token ids index.html's static boot page reads (its boot card + page background) — the runtime caches their
// values for a theme that is not a built-in, so the page is right before the bundle runs (themes.ts, index.html)
const bootIds = [...new Set(hits.filter((h) => h.file === INDEX_HTML && h.code && !h.def && owner.has(h.name)).map((h) => owner.get(h.name)))].sort();
const q = (s) => JSON.stringify(s);
const map = (ids) => ids.map((id) => `  ${q(id)}: ${q(nameOf.get(id))},`).join("\n");
const ts = `// themeVars.gen.ts — GENERATED by tools/modular/gen-theme-vars.mjs from ${TOKENS_JSON}; do not edit by hand.
// Every role and element token of the colour catalogue and its CSS custom property (src/ui/themeNames.ts varName():
// \`--th-<id>\`, dots → dashes, lowerCamel → kebab). ${roleIds.length} roles + ${tokenIds.length} tokens. The id unions type-check
// cssVar("…") and themeColours().colour["…"] (src/ui/themes.ts); the two maps are only bundled where something reads
// them at runtime.

export const ROLE_VARS = {
${map(roleIds)}
} as const;

export const TOKEN_VARS = {
${map(tokenIds)}
} as const;

export type RoleId = keyof typeof ROLE_VARS;
export type TokenId = keyof typeof TOKEN_VARS;
export type ThemeColourId = RoleId | TokenId;

/**
 * Translucent tokens whose CSS spelling keeps a FLOAT alpha ("rgb(r g b / A)") — their pre-token web sites painted a
 * color-mix() alpha; every other translucent colour is spelled "rgba(r, g, b, A)" (Chromium: 8-bit alpha). See
 * src/ui/themeNames.ts cssColour and tools/modular/lib.mjs FLOAT_ALPHA. ${FLOAT_ALPHA.length} ids.
 */
export const FLOAT_ALPHA_IDS: ReadonlySet<string> = new Set([
${[...FLOAT_ALPHA].sort().map((id) => `  ${q(id)},`).join("\n")}
]);

/** The ${bootIds.length} role/token ids index.html's static boot page reads (its boot card and page background). */
export const BOOT_IDS: readonly ThemeColourId[] = [
${bootIds.map((id) => `  ${q(id)},`).join("\n")}
];
`;

const specJson = JSON.stringify(spec) + "\n";

const decl = (id) => `  ${nameOf.get(id)}: ${spell("oled", id)};`;
const block = `${BEGIN}
/* Every role and element token of ${TOKENS_JSON} as --th-<id> (src/ui/themeNames.ts), with the value the web paints
   in the OLED built-in: resolveForApp(oled, tokens, "web"), the step-1a webPins included. applyTheme() (themes.ts)
   sets the same variables on <html> for the active theme; this block only makes CSS work before the bundle runs.
   ${roleIds.length} roles + ${tokenIds.length} element tokens. How to use them: src/theme/MIGRATING.md. */
:root {
  /* roles */
${roleIds.map(decl).join("\n")}
  /* element tokens */
${tokenIds.map(decl).join("\n")}
}
`;
const cssNow = fs.readFileSync(abs(TOKENS_CSS), "utf8");
const bi = cssNow.indexOf(BEGIN);
const ei = cssNow.indexOf(END);
if (bi < 0 || ei < bi) throw new Error(`${TOKENS_CSS}: GENERATED markers not found`);
const css = cssNow.slice(0, bi) + block + cssNow.slice(ei);

// ---- index.html: the static page's own variables, per built-in theme ---------------------------------------------
// Only what the page references outside the block (its boot card and page background), so the page stays small; the
// bundle's tokens.css + applyTheme() take over once they run (inline values on <html> win over these rules).
const htmlNow = fs.readFileSync(abs(INDEX_HTML), "utf8");
const pageRefs = hits.filter((h) => h.file === INDEX_HTML && h.code && !h.def);
for (const h of pageRefs) if (!owner.has(h.name)) fail(`${INDEX_HTML}:${h.line} reads ${h.name}: the static page may only read role/token variables (the generated block defines them)`);
const pageIds = [...new Set(pageRefs.filter((h) => owner.has(h.name)).map((h) => owner.get(h.name)))].sort();
const IND = "      ";
const pageRule = (sel, theme) => `${IND}${sel} {\n${pageIds.map((id) => `${IND}  ${nameOf.get(id)}: ${spell(theme, id)};`).join("\n")}\n${IND}}`;
const pageBlock = `${BEGIN}
${IND}/* The ${pageIds.length} role/token variables this page reads, with their web values per built-in theme (resolveForApp(…, "web")). */
${[pageRule(":root", "oled"), ...Object.keys(resolved).filter((n) => n !== "oled").map((n) => pageRule(`html[data-theme="${n}"]`, n))].join("\n")}
${IND}`;
const hb = htmlNow.indexOf(BEGIN);
const he = htmlNow.indexOf(END);
if (hb < 0 || he < hb) throw new Error(`${INDEX_HTML}: GENERATED markers not found`);
let html = htmlNow.slice(0, hb) + pageBlock + htmlNow.slice(he);
const META = /(<meta name="theme-color" content=")[^"]*(" \/>)/;
if (!META.test(html)) fail(`${INDEX_HTML}: no <meta name="theme-color" content="…" />`);
html = html.replace(META, `$1${cssColour(resolved.oled["window.bg"])}$2`);

// ---- write / check ------------------------------------------------------------------------------------------------
const outputs = [
  [GEN_TS, ts],
  [GEN_SPEC, specJson],
  [TOKENS_CSS, css],
  [INDEX_HTML, html],
];
const bail = () => {
  for (const e of errors) console.error(`gen-theme-vars: ${e}`);
  console.error(`gen-theme-vars: FAILED (${errors.length} problems)`);
  process.exit(1);
};
if (errors.length) bail(); // nothing is written while a check fails
let changed = 0;
for (const [p, text] of outputs) {
  const cur = fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), "utf8") : null;
  if (cur === text) continue;
  changed++;
  if (check) fail(`${p} is stale — run tools/modular/gen-theme-vars.mjs`);
  else fs.writeFileSync(abs(p), text);
}
if (errors.length) bail();
const summary = `${roleIds.length} roles + ${tokenIds.length} tokens = ${allIds.length} variables; ${INDEX_HTML} reads ${pageIds.length}`;
console.log(`gen-theme-vars: ${check ? "up to date" : changed ? `wrote ${changed} file(s)` : "nothing to write"} — ${summary}`);
