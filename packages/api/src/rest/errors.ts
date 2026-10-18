import { z } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import { createTranslator, LOCALE_COOKIE, resolveLocale, type Messages } from '@nextskin/i18n'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from '../env.ts'

type ErrorCode = keyof Messages['errors']
const statuses = {
  mail_not_configured: 400,
  mail_test_failed: 502,
  permission_denied: 403,
  user_not_manageable: 403,
  user_not_found: 404,
  report_not_found: 404,
  report_already_handled: 409,
  closet_item_exists: 409,
  closet_item_not_found: 404,
  texture_type_mismatch: 400,
  report_duplicate: 409,
  report_reason_length: 400,
  texture_not_found: 404,
  texture_not_owned: 403,
  texture_duplicate: 409,
  texture_file_invalid: 400,
  texture_size_invalid: 400,
  texture_file_too_large: 413,
  texture_name_length: 400,
  texture_name_invalid: 400,
  texture_name_rule_misconfigured: 500,
  texture_description_too_long: 400,
  texture_type_invalid: 400,
  password_incorrect: 400,
  email_unchanged: 400,
  locale_invalid: 400,
  email_change_link_invalid: 400,
  admin_cannot_delete_self: 403,
  too_many_requests: 429,
  unauthenticated: 401,
  user_banned: 403,
  email_not_verified: 403,
  score_insufficient: 403,
  player_not_found: 404,
  check_in_too_early: 409,
  invalid_request: 400,
  invalid_origin: 403,
  request_too_large: 413,
  internal_error: 500,
  player_name_rule_misconfigured: 500,
  service_unavailable: 503,
  email_invalid: 400,
  email_domain_not_allowed: 400,
  email_taken: 409,
  password_too_short: 400,
  password_too_long: 400,
  nickname_invalid: 400,
  player_name_required: 400,
  player_name_invalid: 400,
  player_name_length: 400,
  player_name_taken: 409,
  registration_disabled: 403,
  ip_limit_reached: 403,
} as const satisfies Partial<Record<ErrorCode, number>>
type ResponseCode = keyof typeof statuses
const fieldNames: Partial<Record<ResponseCode, string>> = {
  report_reason_length: 'reason',
  texture_file_too_large: 'file',
  texture_file_invalid: 'file',
  texture_size_invalid: 'file',
  texture_name_length: 'name',
  texture_name_invalid: 'name',
  texture_description_too_long: 'description',
  texture_type_invalid: 'type',
  password_incorrect: 'password',
  email_unchanged: 'email',
  locale_invalid: 'locale',
  email_invalid: 'email',
  email_domain_not_allowed: 'email',
  email_taken: 'email',
  password_too_short: 'password',
  password_too_long: 'password',
  nickname_invalid: 'nickname',
  player_name_required: 'playerName',
  player_name_invalid: 'playerName',
  player_name_length: 'playerName',
  player_name_taken: 'playerName',
}

const fieldErrorSchema = z.object({ code: z.string(), message: z.string() })
export const errorSchema = z.object({
  error: fieldErrorSchema.extend({ fields: z.record(z.string(), fieldErrorSchema).optional() }),
})

export function createErrorResponse(core: Core, fieldOverrides: Partial<Record<ResponseCode, string>> = {}) {
  return async <Code extends ResponseCode>(
    c: Context<AppEnv>,
    code: Code,
    params?: Readonly<Record<string, string | number>>,
    invalidFields?: readonly string[],
    status: (typeof statuses)[Code] | 415 = statuses[code],
  ) => {
    // 即使设置读取本身失败，也仍能返回无敏感信息的 JSON 错误。
    const settings = await core.settings.read(['site.locale']).catch(() => ({ 'site.locale': 'zh-CN' as const }))
    const translate = createTranslator(
      resolveLocale({
        cookie: getCookie(c, LOCALE_COOKIE),
        acceptLanguage: c.req.header('accept-language'),
        siteDefault: settings['site.locale'],
      }),
    )
    const messageKey: `errors.${ResponseCode}` = `errors.${code}`
    const error = { code, message: translate(messageKey, params) }
    const field = fieldOverrides[code] ?? fieldNames[code]
    const fields = invalidFields
      ? Object.fromEntries(
          invalidFields.map((name) => [name, { code: 'invalid_value', message: translate('errors.invalid_value') }]),
        )
      : field
        ? { [field]: error }
        : undefined
    return c.json({ error: { ...error, ...(fields ? { fields } : {}) } }, status)
  }
}

export function restErrorCode(error: Error): ResponseCode {
  if (error instanceof DomainError && Object.hasOwn(statuses, error.code)) return error.code as ResponseCode
  if (error instanceof HTTPException) {
    if (error.status === 400) return 'invalid_request'
    if (error.status === 403) return 'invalid_origin'
    if (error.status === 413) return 'request_too_large'
  }
  return 'internal_error'
}

export function logError(error: unknown): void {
  console.error(`[rest] unhandled ${error instanceof Error ? error.name : typeof error}`)
}
