// register.mjs — lets plain Node 22 (type stripping) run the app's TypeScript for the colour-token tools and unit
// tests:  node --no-warnings --import ./tools/modular/register.mjs …
// The same hook as tools/theme-lib/register.mjs (tools/theme-lib/resolve-ts.mjs: a relative import is retried as
// "<specifier>.ts" whenever Node can't find it and it has no real module extension).
import { register } from "node:module";

register("../theme-lib/resolve-ts.mjs", import.meta.url);
