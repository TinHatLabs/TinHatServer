// A minimal JSON Schema (2020-12 subset) checker for the play contract (vectors/views/schema.json). Only the keywords
// that schema uses: type, enum, const, properties, required, additionalProperties, propertyNames, items, minItems,
// maxItems, minimum, maximum, minLength, maxLength, pattern, oneOf, anyOf, $ref (#/$defs/…). Unknown keywords are an
// error (so the schema can't silently use something this doesn't check). Returns a list of "path: problem" strings.
const KNOWN = new Set(["$schema", "$id", "$defs", "$ref", "$comment", "title", "description", "examples", "type", "enum",
    "const", "properties", "required", "additionalProperties", "propertyNames", "items", "minItems", "maxItems",
    "minimum", "maximum", "minLength", "maxLength", "pattern", "oneOf", "anyOf", "x-moves", "x-codes", "x-note"]);

function typeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
    return typeof v;
}
function typeOk(want, v) {
    const t = typeOf(v);
    return want === t || (want === "number" && t === "integer");
}

export function validate(root, schema, value, path = "$") {
    const errs = [];
    check(root, schema, value, path, errs);
    return errs;
}

function check(root, s, v, path, errs) {
    if (s === true) return;
    if (s === false) { errs.push(`${path}: not allowed`); return; }
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`schema keyword ${k} at ${path} is not supported`);
    if (s.$ref) {
        const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
        if (!m || !root.$defs || !(m[1] in root.$defs)) throw new Error(`bad $ref ${s.$ref}`);
        check(root, root.$defs[m[1]], v, path, errs);
    }
    if (s.type !== undefined) {
        const ts = Array.isArray(s.type) ? s.type : [s.type];
        if (!ts.some((t) => typeOk(t, v))) { errs.push(`${path}: type ${typeOf(v)}, want ${ts.join("|")}`); return; }
    }
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(v)) errs.push(`${path}: want ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${path}: ${JSON.stringify(v)} not in enum`);
    const t = typeOf(v);
    if (t === "integer" || t === "number") {
        if (s.minimum !== undefined && v < s.minimum) errs.push(`${path}: ${v} < ${s.minimum}`);
        if (s.maximum !== undefined && v > s.maximum) errs.push(`${path}: ${v} > ${s.maximum}`);
        if (t === "integer" && !Number.isSafeInteger(v)) errs.push(`${path}: not a safe integer`);
    }
    if (t === "string") {
        const n = [...v].length;
        if (s.minLength !== undefined && n < s.minLength) errs.push(`${path}: shorter than ${s.minLength}`);
        if (s.maxLength !== undefined && n > s.maxLength) errs.push(`${path}: longer than ${s.maxLength}`);
        if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v)) errs.push(`${path}: ${JSON.stringify(v)} !~ ${s.pattern}`);
    }
    if (t === "array") {
        if (s.minItems !== undefined && v.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
        if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
        if (s.items !== undefined) v.forEach((x, i) => check(root, s.items, x, `${path}[${i}]`, errs));
    }
    if (t === "object") {
        for (const r of s.required || []) if (!(r in v)) errs.push(`${path}: missing ${r}`);
        const props = s.properties || {};
        for (const [k, x] of Object.entries(v)) {
            if (s.propertyNames) check(root, s.propertyNames, k, `${path}{${k}}`, errs);
            if (k in props) check(root, props[k], x, `${path}.${k}`, errs);
            else if (s.additionalProperties !== undefined) {
                if (s.additionalProperties === false) errs.push(`${path}: unexpected field ${k}`);
                else check(root, s.additionalProperties, x, `${path}.${k}`, errs);
            }
        }
    }
    if (s.oneOf) {
        const ok = s.oneOf.filter((x) => { const e = []; check(root, x, v, path, e); return e.length === 0; });
        if (ok.length !== 1) {
            // name the closest branch's problems, so a failure says something useful
            let best = null;
            for (const x of s.oneOf) { const e = []; check(root, x, v, path, e); if (!best || e.length < best.length) best = e; }
            errs.push(`${path}: matches ${ok.length} of oneOf${ok.length === 0 && best ? ` (closest: ${best.slice(0, 3).join("; ")})` : ""}`);
        }
    }
    if (s.anyOf) {
        const ok = s.anyOf.some((x) => { const e = []; check(root, x, v, path, e); return e.length === 0; });
        if (!ok) errs.push(`${path}: matches none of anyOf`);
    }
}
