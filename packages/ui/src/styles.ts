/** 焦点框：2px 实线，外加 2px 间距（DESIGN.md §9） */
export const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

// 大展台的 16px 网格，×4 时正好 4 个材质像素一格；网格线由 text 按比例混入 stage，不单独设 token（DESIGN.md §2.2）
export const stageGrid = [
  '[--stage-line:color-mix(in_srgb,var(--color-text)_7%,var(--color-stage))]',
  'bg-[linear-gradient(var(--stage-line)_1px,transparent_1px),linear-gradient(90deg,var(--stage-line)_1px,transparent_1px)]',
  'bg-size-[16px_16px] bg-position-[-1px_-1px]',
].join(' ')
