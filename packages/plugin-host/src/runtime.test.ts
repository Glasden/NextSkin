import { definePlugin, type KvApi } from '@nextskin/plugin-sdk'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import type { AnyPluginDefinition } from './manifest.ts'
import type { CoreRpc, InvocationContext, PluginCall, SerializedRequest } from './protocol.ts'
import { loadPlugin, PluginSettingsInvalidError } from './runtime.ts'

const context: InvocationContext = {
  invocationId: 'invocation',
  settings: {},
  site: { url: 'https://skin.example.test', name: 'Test' },
  locale: 'en',
  timeoutMs: 2000,
}
const call: PluginCall = {
  kind: 'intercept',
  name: 'user.register',
  input: { email: 'a@example.test', nickname: 'Alex', playerName: 'Alex', ip: '192.0.2.1', extra: {} },
  scope: { requestId: 'request', actor: { kind: 'system' }, locale: 'en', ip: '192.0.2.1' },
}
const load = (definition: AnyPluginDefinition, rpc: CoreRpc = vi.fn<CoreRpc>()) =>
  loadPlugin({
    id: 'example',
    version: '1.0.0',
    definition,
    messages: {},
    dialect: 'sqlite',
    fallbackLocale: 'zh-CN',
    rpc,
  })

test('事务内拦截器只有本地上下文和 db，即使申请了其他能力', async () => {
  let keys: string[] = []
  const plugin = load(
    definePlugin({
      capabilities: [
        'storage.tables',
        'storage.kv',
        'users.read',
        'users.readPrivate',
        'users.score',
        'players.read',
        'textures.read',
        'textures.readFile',
      ],
      intercept: {
        'user.register': ({ ctx }) => {
          keys = Object.keys(ctx).sort()
          expect(Object.isFrozen(ctx)).toBe(true)
          return Promise.resolve()
        },
      },
    }),
  )
  expect(await plugin.invoke(call, context)).toBeNull()
  expect(keys).toEqual(['db', 'log', 'plugin', 'settings', 'signal', 'site', 't'])
  plugin.unload()
})

test('设置不通过 schema 时抛 PluginSettingsInvalidError，不执行处理函数', async () => {
  const handler = vi.fn(async () => {})
  const plugin = load(
    definePlugin({
      capabilities: [],
      settings: z.object({ count: z.number().positive() }),
      intercept: { 'user.register': handler },
    }),
  )
  await expect(plugin.invoke(call, { ...context, settings: { count: -1 } })).rejects.toBeInstanceOf(
    PluginSettingsInvalidError,
  )
  expect(handler).not.toHaveBeenCalled()
  plugin.unload()
})

test('unload abort 所有在途调用的 ctx.signal', async () => {
  const signals: AbortSignal[] = []
  const plugin = load(
    definePlugin({
      capabilities: [],
      jobs: {
        wait: {
          handler: async ({ ctx }) => {
            signals.push(ctx.signal)
            await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
          },
        },
      },
    }),
  )
  const first = plugin.invoke({ kind: 'job', name: 'wait', payload: {}, attempt: 1 }, context)
  const second = plugin.invoke(
    { kind: 'job', name: 'wait', payload: {}, attempt: 1 },
    { ...context, invocationId: 'second' },
  )
  expect(signals).toHaveLength(2)
  expect(signals.every((s) => !s.aborted)).toBe(true)
  plugin.unload()
  // 停用之后才返回的结果不算数
  await expect(first).rejects.toThrow('plugin unloaded')
  await expect(second).rejects.toThrow('plugin unloaded')
  expect(signals.every((s) => s.aborted)).toBe(true)
})

test('拦截器的非法返回值按失败处理', async () => {
  const plugin = load({
    capabilities: [],
    intercept: { 'user.register': () => Promise.resolve({ action: 'allow' }) },
  } as unknown as AnyPluginDefinition)
  await expect(plugin.invoke(call, context)).rejects.toThrow('拦截器只能')
  plugin.unload()
})

test('fetch 只读 method、headers、body，忽略手写 JS 的其他选项', async () => {
  const rpc = vi.fn<CoreRpc>().mockResolvedValue({ status: 200, statusText: 'OK', headers: [], body: null })
  const plugin = load(
    definePlugin({
      capabilities: [],
      jobs: {
        fetch: {
          async handler({ ctx }) {
            const init = {
              method: 'POST' as const,
              headers: { 'x-test': 'yes' },
              body: 'payload',
              signal: AbortSignal.abort(),
              redirect: 'bad value',
              integrity: 'ignored',
            }
            const response = await ctx.fetch(new URL('https://example.test'), init)
            expect(response.url).toBe('')
            expect(response.redirected).toBe(false)
          },
        },
      },
    }),
    rpc,
  )
  await plugin.invoke({ kind: 'job', name: 'fetch', payload: {}, attempt: 1 }, context)
  const [invocation, method, args] = rpc.mock.calls[0]!
  expect(invocation).toBe('invocation')
  expect(method).toBe('fetch')
  expect(args).toMatchObject({
    method: 'POST',
    url: 'https://example.test/',
    body: new TextEncoder().encode('payload'),
  })
  expect((args as SerializedRequest).headers).toContainEqual(['x-test', 'yes'])
  plugin.unload()
})

test.each([false, true])('users.score 和读取能力合并为一个冻结对象（read=%s）', async (read) => {
  const rpc = vi.fn<CoreRpc>().mockResolvedValue({ status: 'applied', balance: 5 })
  const plugin = load(
    definePlugin({
      capabilities: read ? ['users.score', 'users.read'] : ['users.score'],
      jobs: {
        reward: {
          async handler({ ctx }) {
            expect(Object.isFrozen(ctx.users)).toBe(true)
            expect(Object.keys(ctx.users).sort()).toEqual(read ? ['adjustScore', 'get', 'getMany'] : ['adjustScore'])
            expect(await ctx.users.adjustScore(1, 5, { reason: 'reward', key: 'once' })).toEqual({
              status: 'applied',
              balance: 5,
            })
          },
        },
      },
    }),
    rpc,
  )
  await plugin.invoke({ kind: 'job', name: 'reward', payload: {}, attempt: 1 }, context)
  expect(rpc).toHaveBeenCalledWith('invocation', 'users.adjustScore', {
    uid: 1,
    delta: 5,
    reason: 'reward',
    key: 'once',
  })
  plugin.unload()
})

test('只申请读取能力时没有 adjustScore', async () => {
  const plugin = load(
    definePlugin({
      capabilities: ['users.read'],
      jobs: {
        read: {
          handler({ ctx }) {
            expect(Object.keys(ctx.users).sort()).toEqual(['get', 'getMany'])
            return Promise.resolve()
          },
        },
      },
    }),
  )
  await plugin.invoke({ kind: 'job', name: 'read', payload: {}, attempt: 1 }, context)
  plugin.unload()
})

test.each(['yggdrasil.issueToken', 'user.action'] as const)(
  '事务外 %s 拦截器提供 fetch、kv、jobs 和按能力提供的完整上下文',
  async (name) => {
    let keys: string[] = []
    const rpc = vi.fn<CoreRpc>().mockResolvedValue(null)
    const plugin = load(
      definePlugin({
        capabilities: ['storage.tables', 'storage.kv', 'users.read', 'players.read', 'textures.read'],
        intercept: {
          [name]: async ({ ctx }: { ctx: { kv: KvApi } }) => {
            keys = Object.keys(ctx).sort()
            expect(Object.isFrozen(ctx)).toBe(true)
            await ctx.kv.get('binding')
          },
        },
      }),
      rpc,
    )
    expect(
      await plugin.invoke(
        name === 'user.action'
          ? { kind: 'intercept', name, input: { uid: 1, action: 'texture.upload' }, scope: call.scope }
          : { kind: 'intercept', name, input: { uid: 1, via: 'oauth' }, scope: call.scope },
        context,
      ),
    ).toBeNull()
    expect(keys).toEqual([
      'db',
      'fetch',
      'jobs',
      'kv',
      'log',
      'players',
      'plugin',
      'settings',
      'signal',
      'site',
      't',
      'textures',
      'users',
    ])
    expect(rpc).toHaveBeenCalledWith('invocation', 'kv.get', { key: 'binding' })
    plugin.unload()
  },
)
