// deviceName.ts — the device name a new login gets (initial_device_display_name; client.ts DEVICE_DISPLAY_NAME). Pure:
// deviceName.test.ts runs it in Node.
//   D9: "Tin Hat Web (<Browser> on <OS>)" (settings CORE-CHANGES: was the fixed "Tin Hat (Web)").
//   Inside the Tin Hat Mac app (UA token `TinHatMac/<version>`, share claude/tinhat-macos/WEB-PROPOSAL-MACOS.md):
//   "Tin Hat · Mac", the phone apps' label pattern ("Tin Hat · iPhone (calls and notifications)").
export function deviceDisplayName(ua: string): string {
  if (/(^|\s)TinHatMac\/\S+/.test(ua)) return "Tin Hat · Mac";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "the web";
  return `Tin Hat Web (${br} on ${os})`;
}
