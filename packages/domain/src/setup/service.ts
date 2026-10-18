import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  insertReturningId,
  toIsoTimestamp,
  transactionWithRetry,
  upsert,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { hashPassword } from 'better-auth/crypto'
import type { Kysely } from 'kysely'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/password-policy.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import { adjustScore } from '../score/adjust.ts'
import { encodeSettingValue } from '../settings/codec.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { coreSettingsNamespace, coreSettingsRegistry } from '../settings/registry.ts'
import { validateEmail, validateNickname } from '../users/validation.ts'
import { isSiteInitialized } from './initialized.ts'

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const normalize = (code: string) => code.replace(/[\s-]/g, '').toUpperCase()
const digest = (value: string) => createHash('sha256').update(value).digest()
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

export interface CreateSiteInput {
  setupToken: string
  siteName: string
  siteUrl: string
  email: string
  nickname: string
  password: string
  ip: string | null
  locale: string | null
}

export function createSetup(options: {
  db: Kysely<CoreDatabase>
  file: string | null
  secretKey: string
  settings: ReturnType<typeof createSettingQueries>
  events: Events
  now: () => Date
}) {
  const { db, file, secretKey, settings, events, now } = options
  let pending: Promise<unknown> = Promise.resolve()
  const initialized = () => isSiteInitialized(db)
  const tokenFor = (code: string) =>
    createHmac('sha256', secretKey)
      .update(`nextskin-setup:${normalize(code)}`)
      .digest('base64url')
  async function readCode(): Promise<string | null> {
    if (!file) return null
    try {
      const code = (await readFile(file, 'utf8')).trim()
      return /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(code) ? code : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  async function removeCode(): Promise<void> {
    if (file) await rm(file, { force: true })
  }
  async function verifySession(token: string): Promise<boolean> {
    if (await initialized()) return false
    const code = await readCode()
    return code !== null && equal(token, tokenFor(code))
  }
  return {
    isInitialized: initialized,
    async prepareCode(): Promise<{ status: 'initialized' | 'kept' | 'created'; file: string } | null> {
      if (!file) return null
      if (await initialized()) {
        await removeCode()
        return { status: 'initialized', file }
      }
      if (await readCode()) {
        await chmod(file, 0o600)
        return { status: 'kept', file }
      }
      const code = Array.from({ length: 4 }, () =>
        Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(''),
      ).join('-')
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${code}\n`, { mode: 0o600, flag: 'wx' })
        await chmod(temporary, 0o600)
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
      return { status: 'created', file }
    },
    async verifyCode(code: string): Promise<string | null> {
      if (await initialized()) return null
      const stored = await readCode()
      return stored !== null && equal(normalize(code), normalize(stored)) ? tokenFor(stored) : null
    },
    verifySession,
    removeCode,
    async createSite(input: CreateSiteInput): Promise<{ uid: number }> {
      // 安装完成之后重复提交给出稳定的完成状态；未安装时仍先核对安装会话。
      if (await initialized()) throw new DomainError('setup_completed')
      if (!(await verifySession(input.setupToken))) throw new DomainError('setup_code_required')
      const siteName = input.siteName.trim()
      if ([...siteName].length < 1 || [...siteName].length > 64) throw new DomainError('site_name_invalid')
      const url = coreSettingsRegistry['site.url'].schema.safeParse(input.siteUrl)
      if (!url.success || !url.data) throw new DomainError('site_url_invalid')
      const siteUrl = url.data.replace(/\/+$/, '')
      const email = validateEmail(input.email, { mode: 'deny', domains: [] })
      const nickname = validateNickname(input.nickname)
      if (input.password.length < MIN_PASSWORD_LENGTH)
        throw new DomainError('password_too_short', { min: MIN_PASSWORD_LENGTH })
      if (input.password.length > MAX_PASSWORD_LENGTH)
        throw new DomainError('password_too_long', { max: MAX_PASSWORD_LENGTH })
      const values = await settings.read(['user.initialScore'])
      const password = await hashPassword(input.password)
      const operation = pending.then(() =>
        transactionWithRetry(db, async (tx) => {
          if (await isSiteInitialized(tx)) throw new DomainError('setup_completed')
          const timestamp = toIsoTimestamp(now())
          const date = writeAuthDate(tx, timestamp)
          const uid = await insertReturningId(tx, 'users', {
            nickname,
            email,
            email_verified: true,
            role: 'superadmin',
            registration_ip: input.ip,
            locale: input.locale,
            created_at: date,
            updated_at: date,
            image: null,
            avatar_texture_id: null,
            last_check_in_at: null,
          })
          await tx
            .insertInto('accounts')
            .values({
              user_id: uid,
              provider_id: 'credential',
              account_id: String(uid),
              password,
              access_token: null,
              refresh_token: null,
              id_token: null,
              access_token_expires_at: null,
              refresh_token_expires_at: null,
              scope: null,
              created_at: date,
              updated_at: date,
            })
            .execute()
          if (values['user.initialScore'] > 0)
            await adjustScore(tx, {
              uid,
              delta: values['user.initialScore'],
              reason: 'score.reasons.initial',
              now: timestamp,
            })
          const actor = { kind: 'user', uid, role: 'superadmin' } as const
          await events.emit(
            tx,
            'user.registered',
            actor,
            { user: { uid, nickname, role: 'superadmin', avatarTid: null, registeredAt: timestamp }, extra: {} },
            timestamp,
          )
          for (const [key, value] of [
            ['site.name', siteName],
            ['site.url', siteUrl],
          ] as const) {
            await upsert(tx, 'settings', {
              values: {
                namespace: coreSettingsNamespace,
                key,
                value: encodeSettingValue(key, value, { secretKey }),
                updated_at: timestamp,
              },
              conflict: ['namespace', 'key'],
              update: ['value', 'updated_at'],
            })
          }
          await audit(tx, {
            actor,
            action: 'site.setup',
            subject: { type: 'user', id: uid },
            details: { nickname },
            ip: input.ip,
            now: timestamp,
          })
          return { uid }
        }),
      )
      pending = operation.catch(() => {})
      const result = await operation
      await removeCode()
      return result
    },
  }
}
