// gamebg — "Match the game" chat backgrounds (lane sun-gamebg). The chat background layer (sun-ambience) mounts
// <GameArtLayer roomId roomBg spaceBg?/> above its preset base and below its particles + scrim.
export { GameArtLayer, GameArtView, readInk, useGameArt, type GameArtLayerProps } from "./GameArtLayer";
export { GAMEBG_WORDS } from "./words";
export { useGameBackdrop, useGameArtPrefs, gamebgDebug, type GameBackdrop } from "./runtime";
export { PREF_GAME_ART, artMode, fallbackPreset, gameBackgroundContent, matchGamePlan } from "./model";
