/**
 * 后台改了账号之后给用户发"管理员修改了你的账号"（ADR-0036"通知邮件"）。邮件任务和修改在同一个事务里入队：
 * 修改回滚，信也不会发；没有配置邮件就不入队。理由同 ADR-0023 改邮箱时通知旧地址：管理员账号被人滥用时，原主人至少能知道
 */
import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import type { AdminAccountChange } from '@nextskin/email'
import { matchLocale, type Locale } from '@nextskin/i18n'
import type { Transaction } from 'kysely'
import type { JobRunner } from '../jobs/runner.ts'
import { MAIL_JOB, type MailJobPayload, type MailService } from '../mail/service.ts'
import type { PluginSystem } from '../plugins/system.ts'
import type { createSettingQueries } from '../settings/queries.ts'

/** 通知要用、必须在事务外读好的东西：读设置用的是 db，SQLite 只有一个连接，在事务里读会死锁 */
export interface NoticeContext {
  configured: boolean
  /** 收件人没有设置语言时用它，也用来翻译第三方的名称 */
  siteLocale: Locale
}

export async function readNoticeContext(
  mail: Pick<MailService, 'configured'>,
  settings: ReturnType<typeof createSettingQueries>,
): Promise<NoticeContext> {
  const [configured, values] = await Promise.all([mail.configured(), settings.read(['site.locale'])])
  return { configured, siteLocale: values['site.locale'] }
}

/** 按收件人的语言（ADR-0019），没有设置时用站点默认语言 */
export function recipientLocale(user: { locale: string | null }, context: NoticeContext): Locale {
  return (user.locale ? matchLocale(user.locale) : null) ?? context.siteLocale
}

/**
 * 绑定的第三方在邮件里的名称，按收件人的语言翻译。插件停用了也还认得出它的文案；插件已经卸载时只剩 Provider id
 */
export function bindingName(
  plugins: Pick<PluginSystem, 'get' | 'translate'>,
  pluginId: string,
  providerId: string,
  locale: Locale,
): string {
  const label = plugins.get(pluginId)?.manifest.providers.login.find((item) => item.id === providerId)?.label
  return label === undefined ? providerId : plugins.translate(pluginId, label, locale)
}

/** 在调用方的事务里入队一封通知。to 是收件地址：收回账号改了邮箱时是旧地址 */
export async function notifyAccountChanged(
  tx: Transaction<CoreDatabase>,
  jobs: Pick<JobRunner, 'enqueue'>,
  context: NoticeContext,
  input: { uid: number; to: string; changes: readonly AdminAccountChange[]; at: IsoTimestamp },
): Promise<void> {
  if (!context.configured || input.changes.length === 0) return
  await jobs.enqueue(tx, MAIL_JOB, {
    template: 'adminAccountChanged',
    uid: input.uid,
    to: input.to,
    changes: [...input.changes],
    at: input.at,
  } satisfies MailJobPayload)
}
