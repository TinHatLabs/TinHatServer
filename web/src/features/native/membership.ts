// membership.ts — which call memberships the PAGE may correct or tombstone. Pure: the unit tests run it in Node.
//
// The page's start-up ghost sweep, its own-membership watch and their `{}` tombstones act on the page's OWN device's
// state key only. Inside a Tin Hat app the phone's native call device (bridge 2) is another device of the same
// account, with its own membership under its own key: the page must never sweep or withdraw it. (rtc.ts writes only
// `ownStateKey(userId, its own deviceId)`, so this holds by construction; the guard keeps it so if the app ever reports
// a native device id equal to the page's — a broken app — and makes the rule testable.)

/** The msc3401 session-form state key of one device: `_@user:server_DEVICE_m.call` (rtc.ts ownStateKey). */
export function deviceStateKey(userId: string, deviceId: string): string {
  return `_${userId}_${deviceId}_m.call`;
}

/** May the page's own membership code act on the membership under `stateKey`? */
export function pageOwnsMembership(stateKey: string | null | undefined, userId: string | null | undefined, pageDeviceId: string | null | undefined, nativeDeviceId: string | null): boolean {
  if (!stateKey || !userId || !pageDeviceId) return false;
  if (nativeDeviceId !== null && nativeDeviceId === pageDeviceId) return false;
  return stateKey === deviceStateKey(userId, pageDeviceId);
}
