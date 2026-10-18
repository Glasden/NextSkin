/**
 * 刷新 CDN 缓存（合并了 BS 的 refresh-ali-cdn、refresh-qcloud-cdn、purge-azure-global-cdn）。
 *
 * 站点放在 CDN 后面时，角色换了材质、改了名，CSL 和旧版接口的地址内容就变了；材质删除后它的文件地址也该失效。
 * 这几个事件发生后刷新对应的地址。不申请任何数据访问能力：事件本身带着需要的全部信息。
 * 刷新失败就抛错，核心按退避重试，多次失败后进入死信，在后台的插件页可以重试。
 */
import { definePlugin, secret, z } from '@nextskin/plugin-sdk'
import { BATCH_SIZE, refreshAliyun, refreshAzure, refreshTencent } from './providers.ts'

const azureKeys = [
  'azureTenantId',
  'azureSubscriptionId',
  'azureResourceGroup',
  'azureProfile',
  'azureEndpoint',
] as const
const optionalText = (max: number) => z.string().trim().max(max).default('')

const settings = z
  .object({
    provider: z.enum(['aliyun', 'tencent', 'azure']).default('aliyun'),
    /** CDN 上的站点地址；不填就用站点地址 */
    baseUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
    accessKeyId: z.string().trim().min(1).max(200),
    accessKeySecret: secret(),
    azureTenantId: optionalText(100),
    azureSubscriptionId: optionalText(100),
    azureResourceGroup: optionalText(100),
    azureProfile: optionalText(260),
    azureEndpoint: optionalText(260),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== 'azure') return
    for (const key of azureKeys) if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required' })
  })

type Settings = z.output<typeof settings>

/** 一个角色名对应的、会随材质变化的地址（CSL、USM、旧版接口） */
export function playerPaths(name: string): string[] {
  const n = encodeURIComponent(name)
  return [`/${n}.json`, `/csl/${n}.json`, `/usm/${n}.json`, `/skin/${n}.png`, `/cape/${n}.png`]
}

/** 管理员手填的一行：完整地址或以 / 开头的路径，只认本站的 */
export function normalizePath(line: string, base: string): string | null {
  const text = line.trim()
  if (!text) return null
  try {
    const url = new URL(text, `${base}/`)
    if (url.origin !== new URL(base).origin) return null
    return `${url.pathname}${url.search}`
  } catch {
    return null
  }
}

async function refresh(
  paths: readonly string[],
  ctx: { settings: Settings; site: { url: string }; fetch: (input: Request) => Promise<Response> },
) {
  const base = (ctx.settings.baseUrl || ctx.site.url).replace(/\/+$/, '')
  const unique = [...new Set(paths)]
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE)
    const credentials = { accessKeyId: ctx.settings.accessKeyId, accessKeySecret: ctx.settings.accessKeySecret }
    const fetch = (input: Request) => ctx.fetch(input)
    switch (ctx.settings.provider) {
      case 'aliyun':
        await refreshAliyun(
          batch.map((path) => `${base}${path}`),
          credentials,
          fetch,
        )
        break
      case 'tencent':
        await refreshTencent(
          batch.map((path) => `${base}${path}`),
          credentials,
          fetch,
        )
        break
      case 'azure':
        await refreshAzure(
          batch.map((path) => path.split('?')[0]!),
          credentials,
          {
            tenantId: ctx.settings.azureTenantId,
            subscriptionId: ctx.settings.azureSubscriptionId,
            resourceGroup: ctx.settings.azureResourceGroup,
            profile: ctx.settings.azureProfile,
            endpoint: ctx.settings.azureEndpoint,
          },
          fetch,
        )
        break
    }
  }
}

const refreshBody = z.object({ paths: z.string().max(20_000) })

export default definePlugin({
  capabilities: [],
  network: [
    'https://cdn.aliyuncs.com',
    'https://cdn.tencentcloudapi.com',
    'https://login.microsoftonline.com',
    'https://management.azure.com',
  ],
  settings,
  permissions: { refresh: 'permission.refresh' },

  on: {
    // 同一个 hash 还被别的材质引用时文件不删，地址依然有效，不用刷新
    'texture.deleted': async ({ event, ctx }) => {
      if (event.data.fileDeleted) await refresh([`/textures/${event.data.hash}`], ctx)
    },
    'player.texturesChanged': async ({ event, ctx }) => {
      await refresh(playerPaths(event.data.player.name), ctx)
    },
    'player.renamed': async ({ event, ctx }) => {
      await refresh([...playerPaths(event.data.previousName), ...playerPaths(event.data.player.name)], ctx)
    },
    'player.deleted': async ({ event, ctx }) => {
      await refresh(playerPaths(event.data.name), ctx)
    },
  },

  jobs: {
    refresh: {
      maxAttempts: 5,
      timeoutMs: 30_000,
      async handler({ payload, ctx }) {
        const { paths } = z.object({ paths: z.array(z.string()).max(1000) }).parse(payload)
        await refresh(paths, ctx)
      },
    },
  },

  routes: {
    // 后台手动刷新：先入队，刷新失败的重试和死信与事件触发的一样
    'POST /refresh': {
      auth: 'user',
      permission: 'refresh',
      maxBodyBytes: 32 * 1024,
      rateLimit: { limit: 10, windowSec: 60, by: 'user' },
      async handler({ request, scope, ctx }) {
        const parsed = refreshBody.safeParse(await request.json().catch(() => null))
        const base = (ctx.settings.baseUrl || ctx.site.url).replace(/\/+$/, '')
        const lines = parsed.success ? parsed.data.paths.split('\n').filter((line) => line.trim()) : []
        const paths = lines.map((line) => normalizePath(line, base))
        if (!lines.length || lines.length > 1000 || paths.some((path) => path === null))
          return Response.json({ error: ctx.t('error.invalidPaths', undefined, scope.locale) }, { status: 400 })
        await ctx.jobs.enqueue('refresh', { paths: paths as string[] })
        return Response.json(
          { message: ctx.t('refresh.queued', { count: paths.length }, scope.locale) },
          { status: 202 },
        )
      },
    },
  },

  ui: {
    pages: {
      refresh: {
        area: 'admin',
        title: 'page.refresh',
        permission: 'refresh',
        view: {
          kind: 'form',
          fields: [
            {
              name: 'paths',
              type: 'textarea',
              label: 'field.paths',
              help: 'field.pathsHelp',
              placeholder: 'field.pathsPlaceholder',
              required: true,
              maxLength: 20_000,
            },
          ],
          submit: { route: '/refresh', method: 'POST', label: 'action.refresh' },
        },
      },
    },
    nav: [{ area: 'admin', page: 'refresh', label: 'page.refresh', icon: 'cloud' }],
  },
})
