import { rootLogger, type Logger } from '@nextskin/logging'
import type { JobHandler } from '../jobs/runner.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import type { SiteImageStorage } from './storage.ts'

export const SITE_IMAGE_SWEEP_JOB = 'core:site-image-sweep'
/** 上传了、还没保存的图留这么久（ADR-0042"清理"） */
const GRACE_MS = 86_400_000

/** 删掉站点图片存储里当前设置都没引用、一天以前写的文件，连同写到一半留下的临时文件 */
export function createSiteImageSweep(options: {
  storage: SiteImageStorage
  settings: Pick<ReturnType<typeof createSettingQueries>, 'read'>
  now: () => Date
  logger?: Logger
}): JobHandler {
  const { storage, settings, now } = options
  const log = (options.logger ?? rootLogger()).child({ area: 'site-images' })
  return {
    concurrency: 1,
    async run({ signal }) {
      const files = await storage.list()
      signal.throwIfAborted()
      // 列出文件之后再读设置：期间保存的新图，文件在列表里，引用也读得到
      const values = await settings.read(['site.logo', 'site.favicon'])
      const referenced = new Set([values['site.logo'], values['site.favicon']])
      const cutoff = now().getTime() - GRACE_MS
      let deleted = 0
      for (const { file, modifiedAt } of files) {
        signal.throwIfAborted()
        if (referenced.has(file.slice(0, 64)) || modifiedAt.getTime() >= cutoff) continue
        await storage.delete(file)
        deleted++
      }
      if (deleted) log.info('sweep', { deleted })
    },
  }
}
