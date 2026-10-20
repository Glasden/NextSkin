import { z } from '@hono/zod-openapi'
import { DomainError, type Core } from '@nextskin/domain'
import {
  createTranslator,
  getMessages,
  LOCALE_COOKIE,
  resolveLocale,
  sourceLocale,
  type Messages,
} from '@nextskin/i18n'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from '../env.ts'

type ErrorCode = keyof Messages['errors']
const statuses = {
  import_jobs_busy: 409,
  setup_required: 403,
  setup_completed: 404,
  setup_code_invalid: 403,
  setup_code_required: 401,
  maintenance: 503,
  import_running: 409,
  import_not_running: 409,
  import_run_not_found: 404,
  import_timezone_invalid: 400,
  import_password_method_invalid: 400,
  import_textures_unreadable: 400,
  import_site_url_invalid: 400,
  site_name_invalid: 400,
  site_url_invalid: 400,

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
  admin_own_texture: 403,
  texture_uploader_gone: 409,
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
  plugin_unavailable: 503,
  registration_denied: 403,
  plugin_route_not_found: 404,
  plugin_timeout: 504,
  plugin_error: 502,
  plugin_not_found: 404,
  plugin_migration_failed: 500,
  plugin_load_failed: 500,
  plugin_package_invalid: 400,
  plugin_api_incompatible: 400,
  plugin_id_reserved: 409,
  plugin_version_not_newer: 409,
  plugin_requires_unmet: 409,
  plugin_conflict: 409,
  plugin_package_changed: 409,
  plugin_busy: 409,
  plugin_required_by: 409,
  plugin_official: 400,
  dead_letter_not_found: 404,
  external_login_not_found: 404,
  external_login_unavailable: 503,
  external_login_failed: 502,
  external_login_cancelled: 400,
  external_login_expired: 400,
  external_email_taken: 409,
  identity_bound_elsewhere: 409,
  identity_already_bound: 409,
  already_bound: 409,
  last_login_method: 409,
  external_account_not_found: 404,
  password_already_set: 409,
  session_not_fresh: 403,
  score_out_of_range: 400,
  email_changed: 409,
  device_code_invalid: 400,
  device_code_expired: 400,
  device_code_claimed: 403,
  device_code_processed: 409,
  device_player_required: 400,
  oauth_scope_invalid: 400,
  oauth_client_not_found: 404,
  oauth_client_name_invalid: 400,
  oauth_redirect_uri_invalid: 400,
  oauth_redirect_uri_required: 400,
  oauth_redirect_uris_too_many: 400,
  oauth_redirect_uri_too_long: 400,
  oauth_client_public: 400,
  oauth_client_shared: 403,
  oauth_client_not_manageable: 403,
} as const satisfies Partial<Record<ErrorCode, number>>
type ResponseCode = keyof typeof statuses
const fieldNames: Partial<Record<ResponseCode, string>> = {
  setup_code_invalid: 'code',
  import_timezone_invalid: 'timeZone',
  import_password_method_invalid: 'passwordMethod',
  import_textures_unreadable: 'texturesDirectory',
  import_site_url_invalid: 'siteUrl',
  site_name_invalid: 'siteName',
  site_url_invalid: 'siteUrl',
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
  score_out_of_range: 'delta',
}
/**
 * /api/admin/ 下的接口对管理员说话（ADR-0036"接口"）：复用的错误码在 errors 里是对本人说的（"你的账号已被封禁"），
 * admin.errors 里有同名的键就用它，否则仍用 errors。admin.errors 的参数只能是 errors 里同名键的子集（测试守着）
 */
const ADMIN_PATH = /^\/api\/admin\//
type AdminErrorCode = keyof Messages['admin']['errors'] & ResponseCode
const adminErrorCodes: ReadonlySet<string> = new Set(Object.keys(getMessages(sourceLocale).admin.errors))
function isAdminErrorCode(code: string): code is AdminErrorCode {
  return adminErrorCodes.has(code)
}

const fieldErrorSchema = z.object({ code: z.string(), message: z.string() })
export const errorSchema = z.object({
  error: fieldErrorSchema.extend({
    fields: z.record(z.string(), fieldErrorSchema).optional(),
    plugin: z.string().optional(),
    reason: z.string().optional(),
  }),
})

export function createErrorResponse(
  core: Core,
  fieldOverrides: Partial<Record<ResponseCode, string>> = {},
  databaseFree: boolean | (() => boolean) = false,
) {
  return async <Code extends ResponseCode>(
    c: Context<AppEnv>,
    code: Code,
    params?: Readonly<Record<string, string | number>>,
    invalidFields?: readonly string[],
    status: (typeof statuses)[Code] | 415 = statuses[code],
  ) => {
    // 即使设置读取本身失败，也仍能返回无敏感信息的 JSON 错误。
    const settings = (typeof databaseFree === 'function' ? databaseFree() : databaseFree)
      ? { 'site.locale': 'zh-CN' as const }
      : await core.settings.read(['site.locale']).catch(() => ({ 'site.locale': 'zh-CN' as const }))
    const translate = createTranslator(
      resolveLocale({
        cookie: getCookie(c, LOCALE_COOKIE),
        acceptLanguage: c.req.header('accept-language'),
        siteDefault: settings['site.locale'],
      }),
    )
    const messageKey: `errors.${ResponseCode}` | `admin.errors.${AdminErrorCode}` =
      ADMIN_PATH.test(c.req.path) && isAdminErrorCode(code) ? `admin.errors.${code}` : `errors.${code}`
    const error = {
      code,
      message: translate(messageKey, params),
      // 插件拒绝注册时给的机器可读原因（SDK 的 Deny.code）
      ...(code === 'registration_denied' && params
        ? { plugin: String(params.plugin), reason: String(params.reason) }
        : {}),
    }
    const field = fieldOverrides[code] ?? fieldNames[code]
    const fields = invalidFields
      ? Object.fromEntries(
          invalidFields.map((name) => [
            name,
            code === 'invalid_request' ? { code: 'invalid_value', message: translate('errors.invalid_value') } : error,
          ]),
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
