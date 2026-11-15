// Settings > Privacy > Create report (QOL sweep A34.3): every report used to be "tinhat-diagnostics.txt", so a new one
// replaced the last (desktop) or came out as "(1)" while the status still named the old file (web). Each report now
// gets its own name, stamped with the local date and time. Shared with the desktop (diagnostics.rs report_file_name)
// through testvectors/report-name/vectors.json, byte-identical in both repos.

/** The report's file name for `localMs` = epoch ms shifted by the local UTC offset. */
export function reportFileName(localMs: number): string {
  const iso = new Date(Math.floor(localMs / 1000) * 1000).toISOString(); // 2026-11-14T14:02:33.000Z, read as local
  return `tinhat-diagnostics-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}.txt`;
}

/** Now, as the local clock reads it. */
export function localNowMs(now: Date = new Date()): number {
  return now.getTime() - now.getTimezoneOffset() * 60_000;
}
