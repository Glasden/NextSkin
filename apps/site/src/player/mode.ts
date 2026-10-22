/**
 * 播放器在哪些设备上水合（ADR-0055）：窗口放得下画面、有悬停和精确的指针、没开"减少动态效果"。
 * src/styles/site.css 用同一个条件决定显示播放器还是静帧，改的时候两边一起改
 */
export const PLAYER_MEDIA =
  '(min-width: 960px) and (min-height: 540px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)'
