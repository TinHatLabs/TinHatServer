// words.ts — every visible string of chat backgrounds + particle effects, the SAME words in both apps (the desktop's
// AmbienceWords.qml carries a copy; tools/ambience/words-check.mjs compares them).
export const AMBIENCE_WORDS = {
  // Settings → Appearance → Performance
  backgrounds: "Show chat backgrounds",
  backgroundsHelp: "Rooms can share a background, picked in the room's menu. Off shows your theme's plain background on this device.",
  effects: "Particle effects",
  effectsHelp: "The rain, embers, snow or fireflies a background comes with. They never cover text.",
  pause: "Pause effects when Tin Hat isn't focused",
  pauseHelp: "Tin Hat often sits next to a game: paused effects cost nothing there. Turn this off to keep them moving while you play.",
  pauseSaver: "Save GPU is on, so effects always pause when Tin Hat isn't focused.",
  // the room menu + the sheet
  menu: "Chat background…",
  title: "Chat background",
  none: "None",
  effect: "Effect",
  effectOwn: "The background's own",
  customImage: "Your own image…",
  customLabel: "Your image",
  customPosted: "The image is posted in the chat, so everyone in the room can see it there.",
  customPlainRoom: "This room isn't encrypted: the server can see this image.",
  otherImage: "This image was posted by someone else. To change the background, pick a scene or your own image.",
  particles: "Particles",
  effectsSettings: "Effects settings…",
  customBusy: "Posting the image…",
  customFailed: "Couldn't post the image",
  customFormat: "This picture's format can't be used as a background. Pick a JPEG, PNG, WebP or GIF picture.",
  readOnly: "Only moderators can change this room's background.",
  offHere: "Chat backgrounds are off on this device (Settings → Appearance).",
  forEveryone: "Everyone in this room sees the background you choose.",
  apply: "Apply",
  setFailed: "Couldn't change the background",
} as const;
