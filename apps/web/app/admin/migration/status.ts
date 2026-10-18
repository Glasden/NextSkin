import type { ImportRunStatus } from '@nextskin/importer'

/** 运行结果的徽标颜色：列表和报告页共用。文字本身说明状态（DESIGN.md §9） */
export const RUN_STATUS_TONES: Record<ImportRunStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  running: 'neutral',
  succeeded: 'success',
  blocked: 'danger',
  failed: 'danger',
  cancelled: 'neutral',
}
