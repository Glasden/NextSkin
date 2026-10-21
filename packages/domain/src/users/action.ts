import type { UserAction } from '@nextskin/plugin-sdk'
import { DomainError } from '../errors.ts'
import type { UserActionInterceptor } from '../plugins/system.ts'

/** 在用例的事务之前调用，插件不能占着 SQLite 写锁等待外部服务。 */
export async function assertUserActionAllowed(intercept: UserActionInterceptor, uid: number, action: UserAction) {
  const result = await intercept({ uid, action })
  if (result.action === 'unavailable') throw new DomainError('plugin_unavailable')
  if (result.action === 'deny')
    throw new DomainError('action_denied', { plugin: result.plugin, reason: result.reason, message: result.message })
}
