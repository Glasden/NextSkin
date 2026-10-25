import { getLogger } from '@nextskin/logging'
import type { createSettingQueries } from '../settings/queries.ts'
import { parseHeadCode, type HeadElement } from './head.ts'

export function createCustomCode(settings: Pick<ReturnType<typeof createSettingQueries>, 'read'>) {
  let source: string | undefined
  let head: HeadElement[] = []
  return {
    async page(): Promise<{ head: HeadElement[]; css: string }> {
      const values = await settings.read(['custom.head', 'custom.css'])
      if (source !== values['custom.head']) {
        source = values['custom.head']
        const result = parseHeadCode(source)
        head = result.ok ? result.elements : []
        if (!result.ok)
          getLogger('custom-code').warn('页头代码不符合当前规则，已跳过', {
            reason: result.error.reason,
            line: result.error.line,
          })
      }
      return { head, css: values['custom.css'] }
    },
  }
}
