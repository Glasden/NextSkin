import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { DIAMOND } from '@nextskin/theme'
import type { Kysely } from 'kysely'
import { authorize } from '../admin/context.ts'
import type { AdminActor } from '../admin/types.ts'
import { DomainError } from '../errors.ts'
import type { PluginSystem } from '../plugins/system.ts'
import { createSettingQueries } from '../settings/queries.ts'
import { lockUser, type UserActor } from '../users/lock.ts'
import { createThemeRegistry, type ThemeEntry, type InvalidTheme } from './registry.ts'
import { lockThemeSettings, type ThemeSettings } from './settings.ts'

export type ThemeChange = { default: string } | { enable: string } | { disable: string }
export interface UserThemeView {
  selected: string | null
  stale: boolean
  current: string
  siteDefault: string
  themes: ThemeEntry[]
  /** 小样要的 CSS：启用的每套，加上站点默认的那套（它回落成没启用的钻石青时不在 themes 里） */
  previewCss: string
}
export interface AdminThemeView {
  default: string
  themes: (ThemeEntry & { enabled: boolean; default: boolean })[]
  invalid: InvalidTheme[]
  missing: string[]
}

export function createThemes(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  plugins: Pick<PluginSystem, 'activeUi'>
  secretKey: string
  now: () => Date
}) {
  const { db, settings, plugins, secretKey, now } = options
  const registry = createThemeRegistry(plugins)
  async function view() {
    const values = await settings.read(['theme.default', 'theme.enabled'])
    const { themes, invalid } = registry()
    const selectable = themes.filter((theme) => values['theme.enabled'].includes(theme.id))
    const siteDefault = themes.find((theme) => theme.id === values['theme.default'])?.id ?? DIAMOND
    return { values, themes, invalid, selectable, siteDefault }
  }
  const selectedTheme = async (uid: number) => {
    const row = await db.selectFrom('users').select('theme').where('id', '=', uid).executeTakeFirst()
    return row?.theme ?? null
  }
  return {
    async current(uid: number | null): Promise<{ id: string; css: string | null }> {
      const selected = uid === null ? null : await selectedTheme(uid)
      const state = await view()
      const id = state.selectable.find((theme) => theme.id === selected)?.id ?? state.siteDefault
      return { id, css: id === DIAMOND ? null : state.themes.find((theme) => theme.id === id)!.css }
    },
    async selectableCount(): Promise<number> {
      return (await view()).selectable.length
    },
    async userView(uid: number): Promise<UserThemeView> {
      const selected = await selectedTheme(uid)
      const state = await view()
      const available = state.selectable.some((theme) => theme.id === selected)
      return {
        selected,
        stale: selected !== null && !available,
        current: available ? selected! : state.siteDefault,
        siteDefault: state.siteDefault,
        themes: state.selectable,
        previewCss: state.themes
          .filter((theme) => theme.id === state.siteDefault || state.selectable.includes(theme))
          .map((theme) => theme.css)
          .join(''),
      }
    },
    async setTheme(actor: UserActor, theme: string | null): Promise<{ theme: string | null }> {
      const user = await db.selectFrom('users').select('role').where('id', '=', actor.uid).executeTakeFirst()
      if (!user) throw new DomainError('unauthenticated')
      if (user.role === 'banned') throw new DomainError('user_banned')
      return transactionWithRetry(db, async (tx) => {
        const user = await lockUser(tx, actor.uid)
        if (user.role === 'banned') throw new DomainError('user_banned')
        if (theme !== null) {
          const values = await createSettingQueries(tx, secretKey).read(['theme.enabled'])
          if (!values['theme.enabled'].includes(theme) || !registry().themes.some((entry) => entry.id === theme))
            throw new DomainError('theme_not_found')
        }
        await tx.updateTable('users').set({ theme }).where('id', '=', actor.uid).execute()
        return { theme }
      })
    },
    async adminView(actor: AdminActor): Promise<AdminThemeView> {
      await transactionWithRetry(db, (tx) => authorize(tx, actor, 'settings.manage'))
      const state = await view()
      return {
        default: state.siteDefault,
        themes: state.themes.map((theme) => ({
          ...theme,
          enabled: state.values['theme.enabled'].includes(theme.id),
          default: theme.id === state.siteDefault,
        })),
        invalid: state.invalid,
        missing: state.values['theme.enabled'].filter((id) => !state.themes.some((theme) => theme.id === id)),
      }
    },
    async update(actor: AdminActor, change: ThemeChange): Promise<ThemeSettings> {
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'settings.manage')
        const locked = await lockThemeSettings(tx, toIsoTimestamp(now()), secretKey)
        const values = { ...locked.values, enabled: [...locked.values.enabled] }
        if ('disable' in change) {
          if (change.disable === values.default) throw new DomainError('theme_default_disabled')
          values.enabled = values.enabled.filter((id) => id !== change.disable)
        } else {
          const id = 'default' in change ? change.default : change.enable
          if (!registry().themes.some((theme) => theme.id === id)) throw new DomainError('theme_not_found')
          if (!values.enabled.includes(id)) values.enabled.push(id)
          if ('default' in change) values.default = id
        }
        await locked.save(values, eventActor, actor.ip)
        return values
      })
    },
  }
}
