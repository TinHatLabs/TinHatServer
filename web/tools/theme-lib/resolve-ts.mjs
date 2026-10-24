// resolve-ts.mjs — Node module-resolution hook (see register.mjs): a relative import that Node cannot find and that
// does not end in a module extension (.ts .tsx .js .mjs .cjs .json) is retried as "<specifier>.ts" — so a name with a
// dot in it ("./themeVars.gen") resolves too. Nothing else changes. The one hook of the repo's Node tooling:
// tools/modular/register.mjs registers it as well.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (err?.code === "ERR_MODULE_NOT_FOUND" && relative && !/\.(ts|tsx|js|mjs|cjs|json)$/i.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    throw err;
  }
}
