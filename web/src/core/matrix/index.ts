// @/core/matrix — the one import for Matrix things (see ARCHITECTURE.md "Matrix — @/core/matrix").
//   client   getClient/useClient/peekClient, lifecycle (session.ts drives it)
//   session  sign-in / registration / reset / restore / logout + useSession
//   crypto   useCryptoStatus, restoreFromSecurityKey, SAS verification store, setUpRecovery
//   hooks    useRooms/useRoom/useMembers/useRoomState/useUnread/useTyping/useTimeline/…
//   timeline liveTimelineChain/paginateChainBack — the live timeline + everything linked behind it
//   state    sendState/ensureWritable/containerOf + Tin Hat event-type constants
//   media    useMxcUrl/useEncryptedMedia/uploadFile/decryptAttachment
//   errors   friendlyLoginError/UserFacingError
export {
  getClient,
  peekClient,
  useClient,
  onClientChanged,
  onSessionEnding,
  getClientEpoch,
  listOwnedDatabases,
  CRYPTO_DB_PREFIX,
  SYNC_DB_NAME,
  DEVICE_DISPLAY_NAME,
  type SessionEndReason,
} from "./client";
export * from "./session";
export * from "./crypto";
export * from "./sasPolicy";
export * from "./hooks";
export * from "./state";
export * from "./media";
export * from "./errors";
export { useDerived, readDerived, type DeriveSpec } from "./derive";
export { onStorageLost, kickSenders, probeIdb } from "./resume";
export { liveTimelineChain, paginateChainBack, type TimelineChain } from "./timeline";
import "@/core/devhook";
