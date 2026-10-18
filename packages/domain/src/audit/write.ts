import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Transaction } from 'kysely'

type AuditAction =
  | 'site.setup'
  | 'report.resolve'
  | 'texture.delete'
  | 'user.setRole'
  | 'setting.update'
  | 'plugin.enable'
  | 'plugin.disable'
  | 'plugin.settings'
  | 'plugin.deadLetter'
// 插件和设置项一样没有整数 id，subject_id 记 0，插件 id 放在 details 里（ADR-0028 的做法）
const subjects: Record<AuditAction, string> = {
  'plugin.enable': 'plugin',
  'plugin.disable': 'plugin',
  'plugin.settings': 'plugin',
  'plugin.deadLetter': 'plugin',
  'site.setup': 'user',
  'setting.update': 'setting',
  'report.resolve': 'report',
  'texture.delete': 'texture',
  'user.setRole': 'user',
}
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
  if (subjects[input.action] !== input.subject.type) throw new TypeError('审计动作与对象类型不匹配')
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
