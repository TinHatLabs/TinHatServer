// replaceConfirm.ts — a password sign-in (or a new account) while this browser still holds a saved session asks first
// (polish-night, 2026-10-28; the owner's decision). Signing in starts from clean stores, so the saved session, its device
// and any keys only it holds would go. The desktop asks with the same words (crates/app/src/replace_confirm.rs).
// The dev auto-login hook (?autologin=, DEV builds) is not a person and never asks.

/** The question, word for word in both apps (Continue / Back). */
export const REPLACE_SESSION_TEXT = "This replaces the saved session on this device. Continue?";
export const REPLACE_CONTINUE = "Continue";
export const REPLACE_BACK = "Back";

/** Ask before a sign-in? (pure; replace_confirm::needed) */
export function replaceConfirmNeeded(savedSession: boolean, selfTest: boolean): boolean {
  return savedSession && !selfTest;
}
