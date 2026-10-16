/**
 * 示例：材质文件删除后刷新 CDN 缓存（对应旧版 refresh-ali-cdn / refresh-qcloud-cdn）。
 *
 * 演示：最小的事件插件、出站白名单、敏感设置项、靠抛错触发重试。
 * 不申请任何数据访问能力：事件本身已经带了需要的全部信息。
 */
import { definePlugin, secret, z } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  network: ['https://cdn.aliyuncs.com'],
  settings: z.object({
    accessKeyId: z.string().min(1),
    accessKeySecret: secret(),
  }),

  on: {
    'texture.deleted': async ({ event, ctx }) => {
      // 同一个 hash 还被别的材质引用时文件不会删，URL 依然有效，不需要刷新
      if (!event.data.fileDeleted) return
      const urls = [`${ctx.site.url}/textures/${event.data.hash}`, `${ctx.site.url}/csl/textures/${event.data.hash}`]
      const response = await ctx.fetch(buildRefreshRequest(urls, ctx.settings))
      // 抛错即可：核心会按退避重试，多次失败后进入死信并在后台提示管理员
      if (!response.ok) throw new Error(`CDN 刷新失败：HTTP ${response.status}`)
    },
  },
})

/** 按阿里云 OpenAPI 规范签名的 RefreshObjectCaches 请求；签名实现与示例主题无关，略。 */
declare function buildRefreshRequest(
  urls: readonly string[],
  credentials: { accessKeyId: string; accessKeySecret: string },
): Request
