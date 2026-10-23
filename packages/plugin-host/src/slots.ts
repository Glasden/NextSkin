import type { SlotName } from '@nextskin/plugin-sdk'

/**
 * 插槽的登记表（ADR-0060）：每个插槽属于哪个区域、在哪个页面。插槽名以 SDK 的 SlotName 为准，这里补上只有核心知道的事。
 * 顺序就是文档站"插槽一览"里的序号，同一页面的插槽写在一起；改了要重新生成截图（pnpm docs:screenshots）
 */
export const pluginSlots = {
  'user.dashboard': { area: 'user', path: '/user' },
  'admin.dashboard': { area: 'admin', path: '/admin' },
} as const satisfies Record<SlotName, { area: 'user' | 'admin'; path: string }>
export const MAX_WIDGETS_PER_SLOT = 2
