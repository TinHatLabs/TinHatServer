// uploadWords.ts — A20.2: a soundboard upload's failure in plain words, never the raw cause (a file-system error, the
// network library's text, an HTTP status, a JSON parse error). The desktop's soundboard.rs upload_fail_words is the same
// table; both replay testvectors/soundboard-upload.json (byte-identical).
export type UploadFail = "too-big" | "unreadable" | "network" | "signed-out" | "server" | "bad-reply" | "not-listed" | "picture";

const TOO_BIG = "That clip is bigger than 3 MB. Try a shorter one.";
const SERVER = "The server couldn't take that clip. Try again in a moment.";

export function uploadFailWords(kind: string, status = 0): string {
  switch (kind) {
    case "too-big":
      return TOO_BIG;
    case "unreadable":
      return "That file couldn't be read.";
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
    case "signed-out":
      return "You're not signed in.";
    case "server":
      if (status === 413) return TOO_BIG;
      if (status === 401 || status === 403) return "The server didn't accept your sign-in. Try again in a moment.";
      return SERVER;
    case "not-listed":
      return "Uploaded, but it couldn't be added to your sounds. Try again.";
    case "picture":
      // R3-1: the photo words (core/photoUpload PHOTO_LOCATION_FAIL), the same in both apps
      return "Couldn't remove this photo's location, so it wasn't sent";
    default:
      return SERVER;
  }
}
