import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Transaction } from 'kysely'

/**
 * 审计动作和它的对象类型（docs/schema.md 的 audit_logs.action 指向这里）。插件和设置项一样没有整数 id，
 * subject_id 记 0，插件 id 放在 details 里（ADR-0028 的做法）。角色的操作以主人为对象（ADR-0036）。
 * 核心任务的死信以死信的编号为对象，全部重试、全部删除记 0（ADR-0051）。
 * 后台的审计表对每个动作都要有文案和详情摘要：apps/web 的 audit-table.tsx 按 AuditAction 穷举，类型检查守着
 */
export const AUDIT_ACTIONS = {
  'site.setup': 'user',
  'report.resolve': 'report',
  'texture.delete': 'texture',
  'texture.update': 'texture',
  'texture.unpublish': 'texture',
  'closet.add': 'user',
  'closet.remove': 'user',
  'user.setRole': 'user',
  'user.setNickname': 'user',
  'user.setEmail': 'user',
  'user.setEmailVerified': 'user',
  'user.setPassword': 'user',
  'user.disableTwoFactor': 'user',
  'user.deletePasskeys': 'user',
  'user.unlinkAccount': 'user',
  'user.revokeSessions': 'user',
  'user.adjustScore': 'user',
  'user.delete': 'user',
  'player.rename': 'user',
  'player.setTextures': 'user',
  'player.transfer': 'user',
  'player.delete': 'user',
  'oauthClient.disable': 'oauthClient',
  'oauthClient.enable': 'oauthClient',
  'oauthClient.delete': 'oauthClient',
  'setting.update': 'setting',
  'plugin.enable': 'plugin',
  'plugin.disable': 'plugin',
  'plugin.settings': 'plugin',
  'plugin.deadLetter': 'plugin',
  'plugin.install': 'plugin',
  'plugin.upgrade': 'plugin',
  'plugin.uninstall': 'plugin',
  'plugin.restartHost': 'plugin',
  'job.deadLetter': 'job',
  'notification.send': 'notificationBroadcast',
  'notification.recall': 'notificationBroadcast',
  'diagnostics.export': 'diagnostics',
  'update.prepare': 'update',
  'update.apply': 'update',
  'update.rollback': 'update',
} as const satisfies Record<string, string>
export type AuditAction = keyof typeof AUDIT_ACTIONS

export async function audit(
  tx: Transaction<CoreDatabase>,
  input: {
    actor: Actor
    action: AuditAction
    subject: { type: string; id: number }
    details: Record<string, unknown>
    ip: string | null
    now: IsoTimestamp
  },
): Promise<void> {
  if (AUDIT_ACTIONS[input.action] !== input.subject.type) throw new TypeError('审计动作与对象类型不匹配')
  await tx
    .insertInto('audit_logs')
    .values({
      actor_type: input.actor.kind,
      actor_user_id: input.actor.kind === 'user' ? input.actor.uid : null,
      actor_plugin_id: input.actor.kind === 'plugin' ? input.actor.pluginId : null,
      action: input.action,
      subject_type: input.subject.type,
      subject_id: input.subject.id,
      details: JSON.stringify(input.details),
      ip: input.ip,
      created_at: input.now,
    })
    .execute()
}
