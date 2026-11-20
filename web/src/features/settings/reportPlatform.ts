// reportPlatform.ts — the platform line of a problem report names the Tin Hat app the page runs in, and its
// version, so a report from the phone/Mac apps says which app build it came from (the page's own version is
// already in the report). Pure: the caller passes osName() and nativeInfo().

/** What the report needs from nativeInfo(): kept structural so this file stays free of the bridge. */
export interface ReportAppInfo {
  platform: string;
  app: string;
}

const APP_NAMES: Record<string, string> = {
  android: "Tin Hat for Android",
  ios: "Tin Hat for iPhone and iPad",
  macos: "Tin Hat for Mac",
};

/** A plain version ("0.2.9", "1.4.0-dev"); anything else the app injected is left out of the report. */
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,23}$/;

export function reportPlatform(web: string, app: ReportAppInfo | null): string {
  if (!app) return web;
  const name = APP_NAMES[app.platform] ?? "a Tin Hat app";
  const v = VERSION.test(app.app) ? ` ${app.app}` : "";
  return `${web} in ${name}${v}`;
}
