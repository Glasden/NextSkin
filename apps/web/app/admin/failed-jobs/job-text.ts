// 失败任务页和审计表共用（ADR-0051）：核心任务名、邮件模板、错误码到 admin.failedJobs 下文案键的对应

// 任务名带冒号和连字符，next-intl 的键换成驼峰。不认识的任务（以后的版本加的、已经去掉的）显示任务名
const jobKeys = {
  'core:mail': 'mail',
  'core:texture-lease': 'textureLease',
  'core:texture-recycle': 'textureRecycle',
  'core:texture-remove-row': 'textureRemoveRow',
  'core:texture-sweep': 'textureSweep',
  'core:site-image-sweep': 'siteImageSweep',
  'core:auth-cleanup': 'authCleanup',
  'core:audit-log-cleanup': 'auditLogCleanup',
  'core:plugin-kv-cleanup': 'pluginKvCleanup',
  'core:plugin-cleanup': 'pluginCleanup',
} as const
export type JobKey = (typeof jobKeys)[keyof typeof jobKeys]

export function jobKey(name: string): JobKey | null {
  return Object.hasOwn(jobKeys, name) ? jobKeys[name as keyof typeof jobKeys] : null
}

const templates = [
  'verifyEmail',
  'resetPassword',
  'confirmEmailChange',
  'emailChanged',
  'externalAccountLinked',
  'adminAccountChanged',
] as const
export type MailTemplate = (typeof templates)[number]
/** 这三种进死信时去掉了链接，不能重试，只能让用户重新申请 */
const linkTemplates: readonly MailTemplate[] = ['verifyEmail', 'resetPassword', 'confirmEmailChange']

/** 邮件任务的载荷里页面要用的部分；不是邮件、或者载荷认不出时返回 null */
export function mailPayload(
  name: string,
  payload: unknown,
): { template: MailTemplate | null; to: string | null; linkRemoved: boolean } | null {
  if (name !== 'core:mail' || typeof payload !== 'object' || payload === null) return null
  const { template, to } = payload as { template?: unknown; to?: unknown }
  const known = templates.find((item) => item === template) ?? null
  return {
    template: known,
    to: typeof to === 'string' && to !== '' ? to : null,
    linkRemoved: known !== null && linkTemplates.includes(known),
  }
}

const errorKeys = ['timeout', 'error', 'attempts_exhausted', 'mail_not_configured', 'service_unavailable'] as const
const smtpCodes = [
  'EAUTH',
  'ENOAUTH',
  'ECONNECTION',
  'ETIMEDOUT',
  'EDNS',
  'ETLS',
  'ESOCKET',
  'EPROTOCOL',
  'EENVELOPE',
  'EMESSAGE',
  'EREQUIRETLS',
] as const

export type JobError =
  | { kind: 'known'; key: (typeof errorKeys)[number] }
  | { kind: 'smtp'; code: string; known: (typeof smtpCodes)[number] | null; status: string | null }
  | { kind: 'raw'; text: string }

/** 核心任务只记固定的错误码；邮件是 `smtp:类别码[:应答码]`（ADR-0051） */
export function parseJobError(text: string): JobError {
  const known = errorKeys.find((key) => key === text)
  if (known) return { kind: 'known', key: known }
  const smtp = /^smtp:(E[A-Z]{2,20})(?::(\d{3}))?$/.exec(text)
  if (smtp)
    return {
      kind: 'smtp',
      code: smtp[1]!,
      known: smtpCodes.find((code) => code === smtp[1]) ?? null,
      status: smtp[2] ?? null,
    }
  return { kind: 'raw', text }
}
