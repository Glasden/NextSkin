import { DomainError, MAX_POSE_DENSITY, POSE_KINDS, RENDERER_VERSION, type Core } from '@nextskin/domain'
import type { Hono } from 'hono'
import type { AppEnv } from './env.ts'
import { errorPage, protocolMethodResponse } from './protocol/http.ts'

export function registerRender(app: Hono<AppEnv>, core: Core): void {
  app.on('ALL', ['/render/:version/:kind/:model/:k/:file', '/render/:version/head/:k/:file'], async (c) => {
    const { version, kind, model, k, file } = c.req.param(),
      poseKind = POSE_KINDS.find((value) => value === kind)
    if (
      version !== `v${RENDERER_VERSION}` ||
      !/^[1-9]\d{0,3}$/.test(k) ||
      !/^[0-9a-f]{64}\.png$/.test(file) ||
      (model !== undefined && model !== 'steve' && model !== 'alex' && model !== 'cape') ||
      (model !== undefined && kind !== 'figure' && !poseKind) ||
      (poseKind !== undefined && (model === 'cape' || Number(k) > MAX_POSE_DENSITY))
    )
      return errorPage(404)
    // 新端点的 OPTIONS 也返回 405，不沿用 BS 协议端点的 OPTIONS 200 特例。
    const method = protocolMethodResponse(c.req.method === 'OPTIONS' ? 'POST' : c.req.method, 'GET')
    if (method) return method
    try {
      const hash = file.slice(0, -4)
      const bytes =
        model === undefined
          ? await core.renders.head({ hash, k: Number(k) })
          : poseKind
            ? await core.renders.pose({ hash, kind: poseKind, model, p: Number(k) })
            : await core.renders.figure({ hash, model, k: Number(k) })
      if (!bytes) return errorPage(404)
      return new Response(c.req.method === 'HEAD' ? null : Buffer.from(bytes), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(bytes.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'service_unavailable') {
        return new Response('Service Unavailable', { status: 503, headers: { 'Retry-After': '5' } })
      }
      throw error
    }
  })
}
