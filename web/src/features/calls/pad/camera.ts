// camera.ts — the Pad's Camera mode (PAD-PHONE Step B, web only: the phone joins the call as a camera). Its capture
// uses the camera side the call's own camera uses: the `call-facing` pref that flipCamera keeps (front by default),
// so a phone set to its back camera sends the back camera as the Pad camera too (12.1.16 QOL A21.0).

/** The Pad camera's getUserMedia video constraints for a `call-facing` pref value. */
export function padCameraVideo(facing: unknown): MediaTrackConstraints {
  return { facingMode: facing === "environment" ? "environment" : "user", width: { ideal: 1280 }, height: { ideal: 720 } };
}
