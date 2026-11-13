// retryRule.ts — may a failed event be sent again from the timeline's Retry (launch-gate 2026-11-07, review item 3)?
// A room can turn encrypted between the failed send and the Retry. js-sdk encrypts the event itself when it resends, so
// text is safe, but an attachment or voice note that was uploaded in the clear still points at plaintext bytes: an
// encrypted event carrying a plaintext url. Same oracle as uploads (uploadCrypto: sticky, fails closed).
import { roomEncryptedForUpload, type UploadCryptoClient } from "../../core/matrix/uploadCrypto";
import type { MatrixClient } from "matrix-js-sdk";

export type RetryVerdict = "resend" | "refuse-plain-media" | "unknown";
export const RETRY_PLAIN_MEDIA = "This room is encrypted now and that file was uploaded unencrypted. Delete it and send it again.";
export const RETRY_UNKNOWN = "Couldn't check this room's encryption, so nothing was sent. Try again.";

/** The content points at media uploaded in the clear (an encrypted upload carries `file`, not `url`). */
export function hasPlainMedia(content: Record<string, unknown> | null | undefined): boolean {
  if (!content) return false;
  if (typeof content.url === "string") return true;
  const info = content.info as Record<string, unknown> | undefined;
  return typeof info?.thumbnail_url === "string";
}

export async function retryVerdict(client: UploadCryptoClient | MatrixClient, roomId: string, content: Record<string, unknown> | null | undefined): Promise<RetryVerdict> {
  let encrypted: boolean;
  try {
    encrypted = await roomEncryptedForUpload(client, roomId);
  } catch {
    return "unknown";
  }
  return encrypted && hasPlainMedia(content) ? "refuse-plain-media" : "resend";
}
