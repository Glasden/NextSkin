import { toIsoTimestamp } from '@nextskin/db'
import { definePlugin } from '@nextskin/plugin-sdk'
import { expect, test, vi } from 'vitest'
import { official, pluginEnvironment } from '../plugins/plugins.test-helper.ts'

const env = pluginEnvironment()
test('已启用且已知 manifest 的全部插件共用迁移差集，只读查询不调用插件', async () => {
  const up = vi.fn().mockResolvedValue(undefined)
  await env.boot([
    official('demo', definePlugin({ capabilities: ['storage.tables'], migrations: { '001': { up }, '002': { up } } })),
  ])
  const at = toIsoTimestamp(new Date())
  for (const id of ['demo', 'unknown']) {
    await env.db
      .insertInto('plugins')
      .values({
        id,
        version: '1.0.0',
        is_enabled: 1,
        capabilities: '[]',
        package_hash: null,
        last_error: null,
        installed_at: at,
        updated_at: at,
      })
      .execute()
  }
  expect(await env.core.plugins.pendingMigrations()).toEqual([{ plugin: 'demo', migrations: ['001', '002'] }])
  expect(up).not.toHaveBeenCalled()
  await env.db.insertInto('plugin_migrations').values({ plugin_id: 'demo', name: '001', executed_at: at }).execute()
  expect(await env.core.plugins.pendingMigrations()).toEqual([{ plugin: 'demo', migrations: ['002'] }])
  await env.db.updateTable('plugins').set({ is_enabled: 0 }).where('id', '=', 'demo').execute()
  expect(await env.core.plugins.pendingMigrations()).toEqual([])
  expect(up).not.toHaveBeenCalled()
})
