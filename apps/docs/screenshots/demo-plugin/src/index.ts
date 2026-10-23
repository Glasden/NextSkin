/**
 * 文档站截图用的演示插件（ADR-0060）：在每个插槽里放两个挂件，一个统计、一个 Markdown，截图脚本靠它们找到插槽。
 * 两个是一个插件在一个插槽里的上限（ADR-0059），截出来正好是大屏两列、窄屏一列。新增插槽时在这里跟着加。
 */
import { definePlugin, type StatsSourceResponse } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  ui: {
    widgets: [
      { name: 'user-stats', slot: 'user.dashboard', title: 'widget.stats', view: { kind: 'stats', source: '/stats' } },
      {
        name: 'user-note',
        slot: 'user.dashboard',
        title: 'widget.markdown',
        view: { kind: 'markdown', source: '/note' },
      },
      {
        name: 'admin-stats',
        slot: 'admin.dashboard',
        title: 'widget.stats',
        view: { kind: 'stats', source: '/stats' },
      },
      {
        name: 'admin-note',
        slot: 'admin.dashboard',
        title: 'widget.markdown',
        view: { kind: 'markdown', source: '/note' },
      },
    ],
  },
  routes: {
    'GET /stats': {
      auth: 'user',
      async handler({ scope, ctx }) {
        return Response.json({
          items: [
            { label: 'stats.first', value: 12 },
            { label: 'stats.second', value: 1024 },
            { label: 'stats.third', value: ctx.t('stats.done', undefined, scope.locale) },
          ],
        } satisfies StatsSourceResponse)
      },
    },
    'GET /note': {
      auth: 'user',
      async handler({ scope, ctx }) {
        return new Response(ctx.t('note', undefined, scope.locale), {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        })
      },
    },
  },
})
