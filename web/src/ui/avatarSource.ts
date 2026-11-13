// avatarSource.ts — what an Avatar may load (12.1.12, assembly review). A picture is an mxc:// (fetched through your own
// server as an object URL) or a local blob:/data: URL. Anything else (an http(s) avatar_url someone put in their
// profile or member event) is never loaded: the browser would reach that server directly and tell it you were shown
// this person. The desktop reads mxc:// only.
export type AvatarSource = { kind: "mxc"; url: string } | { kind: "inline"; url: string } | { kind: "none" };

export function avatarSource(imageSource: string | null | undefined): AvatarSource {
  if (typeof imageSource !== "string" || !imageSource) return { kind: "none" };
  if (imageSource.startsWith("mxc://")) return { kind: "mxc", url: imageSource };
  if (/^(blob|data):/i.test(imageSource)) return { kind: "inline", url: imageSource };
  return { kind: "none" };
}
