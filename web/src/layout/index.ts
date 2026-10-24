// index.ts — the layout engine (TypeScript REFERENCE of the contract LAYOUT.md, a byte
// copy of which is src/layout/LAYOUT.md). Pure data in, pure data out: no DOM, no I/O, no clock, no randomness. The
// desktop's Rust port (crates/layout) must reproduce the shared vectors (src/layout/testvectors/) byte for byte.
export type { JObj, Json } from "./json";
export { canon, clone, pretty, readJson } from "./json";
export { REGION_ORDER, REGISTRY, PRESET_NAMES, classicDesktop, classicPhone, internalDesktop, presetDesktop, presetPhone } from "./schema";
export { INFO_NOTES, repairDesktop, repairDesktopText, repairPhone, repairPhoneText, validateDesktop, validatePhone } from "./repair";
export { normalize } from "./normalize";
export type { OpResult } from "./ops";
export { applyOp } from "./ops";
export type { SolveOut } from "./solve";
export { sc, solve, solveDetail, unscale } from "./solve";
export type { Zone } from "./dropzones";
export { dropZones } from "./dropzones";
export type { SaveReq, SaveResult } from "./sync";
export type { Projection } from "./sync";
export { Device, cmpEntry, higher, includes, merge, project, readDoc, runSync, save, tupleOf } from "./sync";
export { migrate, seamPm } from "./migrate";
