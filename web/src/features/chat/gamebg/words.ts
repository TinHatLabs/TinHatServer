// words.ts — every visible string of "Match the game" (lane sun-gamebg), the SAME words in both apps (the desktop's
// GameArtWords.qml carries a copy).
export const GAMEBG_WORDS = {
  // Settings → Appearance → Performance (next to "Show chat backgrounds")
  gameArt: "Game art backgrounds",
  gameArtHelp: "Behind a room's chat, show the art of the game people there are playing, unless the room picked its own background.",
  // the room's "Chat background" sheet
  matchGame: "Match the game",
  matchGameHelp: "Shows the art of the game most people here are playing, from the statuses they share. When nobody is playing, the room looks as usual.",
} as const;
