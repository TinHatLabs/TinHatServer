/// <reference types="vite/client" />
/** true only in a lab build (`vite dev`, `TW_LAB_BUILD=1 vite build`): vite.config.ts `define`, R3-5 */
declare const __TW_LAB__: boolean;
declare module "*.module.css" { const c: Record<string, string>; export default c; }
