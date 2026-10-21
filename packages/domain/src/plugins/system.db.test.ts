import { countRows, dialectOf, toIsoTimestamp, writeAuthDate } from '@nextskin/db'
import { loadPlugin, remoteDialect, type CoreRpc, type InvocationContext, type PluginCall } from '@nextskin/plugin-host'
import { definePlugin, deny, table, type CoreInterceptors } from '@nextskin/plugin-sdk'
import { Kysely } from 'kysely'
import { afterEach, expect, test, vi } from 'vitest'
import { DomainError } from '../errors.ts'
import { unavailableError } from './host.ts'
import { missUuidPrecheckOnce } from '../players/uuid-race.test-helper.ts'
import { official, pluginEnvironment } from './plugins.test-helper.ts'

const env = pluginEnvironment()
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function recorder(handler: (email: string) => void = () => {}, priority = 100) {
  return definePlugin({
    capabilities: ['storage.tables'],
    tables: { records: table<{ value: string }>() },
    migrations: {
      '001': {
        up: async (db) => {
          // eslint-disable-next-line nextskin/no-dialect-specific-sql -- 插件迁移使用远程 Kysely，由网关处理方言。
          await db.schema
            .createTable('records')
            .addColumn('value', 'varchar(128)', (c) => c.notNull())
            .execute()
        },
      },
    },
    intercept: {
      'user.register': {
        priority,
        handler: async ({ ctx, input }) => {
          handler(input.email)
          await ctx.db.insertInto('records').values({ value: input.email }).execute()
        },
      },
    },
  })
}
async function enable(...ids: string[]) {
  const actor = await env.actor()
  for (const id of ids) await env.core.plugins.admin.enable(actor, id)
  return actor
}
function injected(
  run: (call: PluginCall, context: InvocationContext, rpc: CoreRpc) => Promise<unknown>,
): typeof loadPlugin {
  return (options) => {
    const real = loadPlugin(options)
    return {
      ...real,
      invoke: (call, context) =>
        call.kind === 'migrate' || call.kind === 'validateSettings'
          ? real.invoke(call, context)
          : run(call, context, options.rpc),
    }
  }
}
const records = () =>
  env.db.withTables<{ p_a__records: { value: string } }>().selectFrom('p_a__records').selectAll().execute()

test('拦截器放行时用户、角色和插件表一起提交', async () => {
  await env.boot([official('a', recorder())])
  await enable('a')
  const input = env.input()
  const result = await env.core.users.register(input)
  expect(
    await env.db.selectFrom('users').select('email').where('id', '=', result.uid).executeTakeFirstOrThrow(),
  ).toEqual({ email: input.email })
  expect(await env.db.selectFrom('players').select('name').where('user_id', '=', result.uid).execute()).toEqual([
    { name: input.playerName },
  ])
  expect(await records()).toEqual([{ value: input.email }])
})

test('deny 保留 plugin/reason/message，不写用户、角色', async () => {
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        intercept: { 'user.register': () => Promise.resolve(deny('bad_code', '邀请码无效')) },
      }),
    ),
  ])
  await enable('a')
  const input = env.input()
  const failure = await env.core.users.register(input).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(DomainError)
  expect(failure).toMatchObject({
    code: 'registration_denied',
    params: { plugin: 'a', reason: 'bad_code', message: '邀请码无效' },
  })
  expect(await countRows(env.db.selectFrom('users').where('email', '=', input.email))).toBe(0)
  expect(await countRows(env.db.selectFrom('players'))).toBe(0)
})

test('按 priority 再按 id 调用；后一个 deny 回滚前一个插件的写入', async () => {
  const order: string[] = []
  await env.boot([
    official(
      'b',
      definePlugin({
        capabilities: [],
        intercept: {
          'user.register': {
            priority: 10,
            handler: () => {
              order.push('b')
              return Promise.resolve(deny('no', 'No'))
            },
          },
        },
      }),
    ),
    official(
      'a',
      recorder(() => order.push('a'), 10),
    ),
    official(
      'c',
      definePlugin({
        capabilities: [],
        intercept: {
          'user.register': {
            priority: 1,
            handler: () => {
              order.push('c')
              return Promise.resolve()
            },
          },
        },
      }),
    ),
    official(
      'd',
      definePlugin({
        capabilities: [],
        intercept: {
          'user.register': {
            priority: 20,
            handler: () => {
              order.push('d')
              return Promise.resolve()
            },
          },
        },
      }),
    ),
  ])
  await enable('b', 'a', 'c', 'd')
  await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'registration_denied' })
  expect(order).toEqual(['c', 'a', 'b'])
  expect(await records()).toEqual([])
  expect(await countRows(env.db.selectFrom('players'))).toBe(0)
})

test('UUID 竞争重跑事务，拦截器调用两次但只提交一次写入', async () => {
  let calls = 0
  const plugins = [
    official(
      'a',
      recorder(() => calls++),
    ),
  ]
  await env.boot(plugins)
  await env.core.users.register(env.input({ playerName: 'Steve' }))
  await env.db.updateTable('players').set({ name: 'Renamed', name_key: 'renamed' }).execute()
  await env.boot(plugins, { db: env.db.withPlugin(missUuidPrecheckOnce()) })
  await enable('a')
  const input = env.input({ playerName: 'Steve' })
  await env.core.users.register(input)
  expect(calls).toBe(2)
  expect(await records()).toEqual([{ value: input.email }])
  expect(await countRows(env.db.selectFrom('players'))).toBe(2)
})

test('300 ms 超时回滚并释放写锁，停用后下一次注册不再调用插件', async () => {
  let aborted = false
  let interceptedAt = 0
  const definition = recorder()
  await env.boot([
    official('a', {
      ...definition,
      intercept: {
        'user.register': async ({ ctx, input }) => {
          interceptedAt = performance.now()
          await ctx.db.insertInto('records').values({ value: input.email }).execute()
          ctx.signal.addEventListener(
            'abort',
            () => {
              aborted = true
            },
            { once: true },
          )
          await new Promise<void>(() => {})
        },
      },
    }),
  ])
  const actor = await enable('a')
  await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
  // 只量拦截器占用事务的时间；注册前的密码哈希不占写锁。
  expect(performance.now() - interceptedAt).toBeLessThan(450)
  expect(aborted).toBe(true)
  expect(await records()).toEqual([])
  // 不量时间：注册里有密码哈希，机器忙的时候说不准；插件没被调用就不会再等 300 ms
  const calledAt = interceptedAt
  await env.core.plugins.admin.disable(actor, 'a')
  await env.core.users.register(env.input())
  expect(interceptedAt).toBe(calledAt)
})

test('连续三次异常熔断，第四次不调用；30 秒冷却后恢复', async () => {
  const handler = vi.fn<() => Promise<void>>(() => Promise.reject(new Error('failure')))
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.register': handler } }))])
  await enable('a')
  for (let n = 0; n < 4; n++)
    await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
  expect(handler).toHaveBeenCalledTimes(3)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now + 30_001)
  handler.mockImplementation(async () => {})
  await env.core.users.register(env.input())
  expect(handler).toHaveBeenCalledTimes(4)
})

test('成功一次清零连续失败计数', async () => {
  let fail = true
  const handler = vi.fn(() => (fail ? Promise.reject(new Error('failure')) : Promise.resolve()))
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.register': handler } }))])
  await enable('a')
  for (let n = 0; n < 2; n++)
    await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
  fail = false
  await env.core.users.register(env.input())
  fail = true
  for (let n = 0; n < 3; n++)
    await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
  expect(handler).toHaveBeenCalledTimes(6)
  await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
  expect(handler).toHaveBeenCalledTimes(6)
})

test('完全受控插件的非法拦截返回值也按失败处理', async () => {
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.register': async () => {} } }))], {
    plugins: { load: injected(() => Promise.resolve({ action: 'allow' })) },
  })
  await enable('a')
  await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
})

test('完全受控插件：事务内拒绝 kv/fetch/jobs/users RPC，允许 db.query', async () => {
  const denied: string[] = []
  await env.boot(
    [official('a', { ...recorder(), capabilities: ['storage.tables', 'storage.kv', 'users.read', 'users.score'] })],
    {
      plugins: {
        load: injected(async (_, context, rpc) => {
          for (const [method, args] of [
            ['kv.get', { key: 'key' }],
            ['fetch', { method: 'GET', url: 'https://api.example.test', headers: [], body: null }],
            ['jobs.enqueue', { name: 'missing', payload: {} }],
            ['users.get', { uid: 1 }],
            ['users.adjustScore', { uid: 1, delta: 1, reason: 'reward', key: 'once' }],
          ] as const) {
            await expect(rpc(context.invocationId, method, args)).rejects.toMatchObject({ name: 'PluginCallRejected' })
            denied.push(method)
          }
          const db = new Kysely<{ records: { value: string } }>({
            dialect: remoteDialect(dialectOf(env.db), (node) => rpc(context.invocationId, 'db.query', { node })),
          })
          await db.insertInto('records').values({ value: 'allowed' }).execute()
          return null
        }),
      },
    },
  )
  await enable('a')
  await env.core.users.register(env.input())
  expect(denied).toEqual(['kv.get', 'fetch', 'jobs.enqueue', 'users.get', 'users.adjustScore'])
  expect(await records()).toEqual([{ value: 'allowed' }])
})

test('完全受控插件：未授予能力、过期和伪造 invocationId 都拒绝', async () => {
  let rpc!: CoreRpc
  let oldId = ''
  const definition = definePlugin({
    capabilities: ['users.read'],
    routes: { 'GET /': { auth: 'public', handler: () => Promise.resolve(new Response()) } },
  })
  await env.boot([official('a', definition)], {
    plugins: {
      load: injected(async (_, context, send) => {
        rpc = send
        oldId = context.invocationId
        await expect(send(oldId, 'kv.set', { key: 'key', value: 1 })).rejects.toMatchObject({
          name: 'PluginCallRejected',
        })
        await expect(send(oldId, 'users.findByEmail', { email: 'a@example.test' })).rejects.toMatchObject({
          name: 'PluginCallRejected',
        })
        await expect(
          send(oldId, 'users.adjustScore', { uid: 1, delta: 1, reason: 'reward', key: 'once' }),
        ).rejects.toMatchObject({ name: 'PluginCallRejected' })
        expect(await send(oldId, 'users.get', { uid: 2147483647 })).toBeNull()
        return { status: 200, statusText: 'OK', headers: [], body: null }
      }),
    },
  })
  await enable('a')
  await env.core.plugins.route(routeInput('/'))
  await expect(rpc(oldId, 'users.get', { uid: 2147483647 })).rejects.toMatchObject({ name: 'PluginCallRejected' })
  await expect(rpc('forged', 'users.get', { uid: 2147483647 })).rejects.toMatchObject({ name: 'PluginCallRejected' })
})

test('非迁移调用禁止 DDL，迁移允许建表', async () => {
  let rejection: unknown
  await env.boot([official('a', recorder())], {
    plugins: {
      load: injected(async (_, context, rpc) => {
        const db = new Kysely<{ records: { value: string } }>({
          dialect: remoteDialect(dialectOf(env.db), (node) => rpc(context.invocationId, 'db.query', { node })),
        })
        try {
          await db.schema.dropTable('records').execute()
        } catch (error) {
          rejection = error
        }
        return null
      }),
    },
  })
  await enable('a')
  expect((await env.db.introspection.getTables()).map((t) => t.name)).toContain('p_a__records')
  await env.core.users.register(env.input())
  expect(rejection).toMatchObject({ name: 'PluginDbError', code: 'rejected' })
  expect(await records()).toEqual([])
})

function fieldPlugin(id: string, name: string, seen: Record<string, unknown>, required = false) {
  return official(
    id,
    definePlugin({
      capabilities: [],
      ui: { formFields: [{ form: 'auth.register', field: { name, label: 'field', type: 'text', required } }] },
      intercept: {
        'user.register': ({ input }) => {
          seen[`${id}.intercept`] = input.extra
          return Promise.resolve()
        },
      },
      on: {
        'user.registered': ({ event }) => {
          seen[`${id}.event`] = event.data.extra
          return Promise.resolve()
        },
      },
    }),
  )
}

test('字段按插件隔离，事件展开为每个订阅插件各自的任务', async () => {
  const seen: Record<string, unknown> = {}
  await env.boot([fieldPlugin('a', 'code', seen), fieldPlugin('b', 'note', seen)])
  await enable('a', 'b')
  await env.core.users.register(env.input({ plugins: { a: { code: 'x' }, b: { note: 'y' } } }))
  expect(
    (await env.db.selectFrom('jobs').select('name').where('name', 'like', 'plugin:%').execute())
      .map((r) => r.name)
      .sort(),
  ).toEqual(['plugin:a:on:user.registered', 'plugin:b:on:user.registered'])
  await env.core.jobs.drain()
  expect.soft(seen['a.intercept']).toEqual({ code: 'x' })
  expect.soft(seen['b.intercept']).toEqual({ note: 'y' })
  expect.soft(seen['a.event']).toEqual({ code: 'x' })
  expect.soft(seen['b.event']).toEqual({ note: 'y' })
})

test.each([
  ['必填缺失', {}, 'a.code', true],
  ['字段类型错误', { a: { code: { nested: 'bad' } } }, 'a.code', false],
] as const)('%s 返回 invalid_request，出错的键是 <插件 id>.<字段名>', async (_, plugins, field, required) => {
  await env.boot([fieldPlugin('a', 'code', {}, required)])
  await enable('a')
  await expect(env.core.users.register(env.input({ plugins }))).rejects.toMatchObject({
    code: 'invalid_request',
    fields: [field],
  })
})

test('没有声明的字段直接丢掉：提交表单时插件可能刚好停用了', async () => {
  const seen: Record<string, unknown> = {}
  await env.boot([fieldPlugin('a', 'code', seen)])
  await enable('a')
  await env.core.users.register(env.input({ plugins: { a: { code: 'x', unknown: 'bad' }, ghost: { code: 'y' } } }))
  expect(seen['a.intercept']).toEqual({ code: 'x' })
})

function routeInput(
  path: string,
  user: { uid: number; role: 'user' | 'banned' | 'admin' } | null = null,
  body: Uint8Array | null = null,
) {
  return {
    pluginId: 'a',
    method: 'GET',
    path,
    user,
    ip: '192.0.2.1',
    locale: 'en',
    request: { method: 'GET', url: `https://skin.example.test/plugins/a${path}`, headers: [], body },
  }
}

test('路由：公开响应、参数解码、元数据与未匹配路径', async () => {
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        routes: {
          'GET /hello/:name': {
            auth: 'public',
            handler: ({ params }) =>
              Promise.resolve(new Response(params.name, { status: 202, headers: { 'x-plugin': 'a' } })),
          },
        },
      }),
    ),
  ])
  await enable('a')
  const response = await env.core.plugins.route(routeInput('/hello/%E4%BD%A0%E5%A5%BD'))
  expect(response.status).toBe(202)
  expect(response.headers).toContainEqual(['x-plugin', 'a'])
  expect(new TextDecoder().decode(response.body)).toBe('你好')
  expect(env.core.plugins.routeOf('a', 'GET', '/hello/name')).toMatchObject({
    method: 'GET',
    path: '/hello/:name',
    auth: 'public',
    permission: null,
  })
  expect(env.core.plugins.routeOf('a', 'POST', '/hello/name')).toBeNull()
  await expect(env.core.plugins.route(routeInput('/missing'))).rejects.toMatchObject({ code: 'plugin_route_not_found' })
})

test('路由：用户认证、封禁、具名权限与请求体上限', async () => {
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        permissions: { manage: 'manage' },
        routes: {
          'GET /user': { auth: 'user', handler: () => Promise.resolve(new Response('user')) },
          'GET /admin': {
            auth: 'user',
            permission: 'manage',
            maxBodyBytes: 2,
            handler: () => Promise.resolve(new Response('admin')),
          },
        },
      }),
    ),
  ])
  await enable('a')
  await expect(env.core.plugins.route(routeInput('/user'))).rejects.toMatchObject({ code: 'unauthenticated' })
  await expect(env.core.plugins.route(routeInput('/user', { uid: 1, role: 'banned' }))).rejects.toMatchObject({
    code: 'user_banned',
  })
  expect((await env.core.plugins.route(routeInput('/user', { uid: 1, role: 'user' }))).status).toBe(200)
  await expect(env.core.plugins.route(routeInput('/admin', { uid: 1, role: 'user' }))).rejects.toMatchObject({
    code: 'permission_denied',
  })
  expect((await env.core.plugins.route(routeInput('/admin', { uid: 1, role: 'admin' }))).status).toBe(200)
  await expect(
    env.core.plugins.route(routeInput('/admin', { uid: 1, role: 'admin' }, new Uint8Array(3))),
  ).rejects.toMatchObject({ code: 'request_too_large' })
})

test('等待 ctx.signal 后返回仍必须算超时，不能放行注册', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const entered = Promise.withResolvers<void>()
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        intercept: {
          'user.register': async ({ ctx }) => {
            entered.resolve()
            await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
          },
        },
      }),
    ),
  ])
  await enable('a')
  const input = env.input()
  const rejected = expect.soft(env.core.users.register(input)).rejects.toMatchObject({ code: 'plugin_unavailable' })
  await entered.promise
  await vi.advanceTimersByTimeAsync(300)
  await rejected
  expect(await countRows(env.db.selectFrom('users').where('email', '=', input.email))).toBe(0)
})

test('非法返回值连续三次也必须熔断，第四次不调用', async () => {
  const invoke = vi.fn(() => Promise.resolve({ action: 'allow' }))
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.register': async () => {} } }))], {
    plugins: { load: injected(invoke) },
  })
  await enable('a')
  for (let n = 0; n < 4; n++)
    await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
  expect(invoke).toHaveBeenCalledTimes(3)
})

/** 插件准备上下文时读站点设置的那一步停住，直到 release() */
function holdSiteSettings() {
  const settings = env.core.settings
  const read = settings.read.bind(settings)
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let held = false
  vi.spyOn(settings, 'read').mockImplementation((async (keys: readonly string[]) => {
    if (!held && keys.length === 3 && ['site.url', 'site.name', 'site.locale'].every((key) => keys.includes(key))) {
      held = true
      entered.resolve()
      await released.promise
    }
    return read(keys as never)
  }) as typeof settings.read)
  return { entered: entered.promise, release: () => released.resolve() }
}

test('准备上下文卡住也按 300 ms 拒绝注册：不调用插件，写锁按时释放', async () => {
  let called = false
  await env.boot([
    official(
      'a',
      recorder(() => (called = true)),
    ),
  ])
  await enable('a')
  const hold = holdSiteSettings()
  const registration = env.core.users.register(env.input())
  await hold.entered
  const enteredAt = performance.now()
  await expect(registration).rejects.toMatchObject({ code: 'plugin_unavailable' })
  expect(performance.now() - enteredAt).toBeLessThan(450)
  hold.release()
  expect(called).toBe(false)
  expect(await countRows(env.db.selectFrom('users').where('email', 'like', 'user%'))).toBe(0)
})

test('准备上下文时插件被停用：不再调用插件', async () => {
  let calls = 0
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        routes: {
          'GET /hello': {
            auth: 'public',
            handler: () => {
              calls++
              return Promise.resolve(new Response('late'))
            },
          },
        },
      }),
    ),
  ])
  const actor = await enable('a')
  const hold = holdSiteSettings()
  const pending = env.core.plugins.route(routeInput('/hello'))
  await hold.entered
  await env.core.plugins.admin.disable(actor, 'a')
  hold.release()
  // 插件已经停用：和 host 不可用时一样按 503 处理
  await expect(pending).rejects.toMatchObject({ code: 'plugin_unavailable' })
  expect(calls).toBe(0)
})

test('准备上下文时先改了授权（换代）、再被停用：同样不再调用插件', async () => {
  let calls = 0
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: ['users.read'],
        routes: {
          'GET /hello': {
            auth: 'public',
            handler: () => {
              calls++
              return Promise.resolve(new Response('late'))
            },
          },
        },
      }),
    ),
  ])
  const actor = await enable('a')
  const hold = holdSiteSettings()
  const pending = env.core.plugins.route(routeInput('/hello'))
  await hold.entered
  // 改授权是换代：准备中的调用拿着的旧登记被换掉，停用只标记新的登记
  await env.db.updateTable('plugins').set({ capabilities: '[]' }).where('id', '=', 'a').execute()
  await env.core.plugins.sync()
  expect(env.core.plugins.isActive('a')).toBe(true)
  await env.core.plugins.admin.disable(actor, 'a')
  hold.release()
  await expect(pending).rejects.toMatchObject({ code: 'plugin_unavailable' })
  expect(calls).toBe(0)
})

test('public 路由经核心直调也匿名，并共用路由限流', async () => {
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        routes: {
          'GET /public': {
            auth: 'public',
            rateLimit: { limit: 2, windowSec: 60, by: 'ip' },
            handler: ({ scope }) => Promise.resolve(Response.json(scope.actor)),
          },
        },
      }),
    ),
  ])
  await enable('a')
  const input = routeInput('/public', { uid: 1, role: 'admin' })
  const response = await env.core.plugins.route(input)
  expect(JSON.parse(new TextDecoder().decode(response.body ?? undefined))).toEqual({ kind: 'system' })
  await env.core.plugins.route({ ...input, user: null })
  await expect(env.core.plugins.route(input)).rejects.toMatchObject({
    code: 'too_many_requests',
    params: { retryAfter: 60 },
  })
  await expect(env.core.plugins.route({ ...input, ip: '192.0.2.2' })).resolves.toMatchObject({ status: 200 })
})

test('login Provider 的 authorize 和 exchange 默认使用请求语言', async () => {
  const seen: string[] = []
  const plugin = official(
    'a',
    definePlugin({
      capabilities: [],
      providers: {
        login: [
          {
            id: 'login',
            label: 'login',
            icon: 'login',
            authorizeUrl: ({ ctx }) => {
              seen.push(ctx.t('hello'))
              return Promise.resolve('https://example.test/authorize')
            },
            exchange: ({ ctx }) => {
              seen.push(ctx.t('hello'))
              return Promise.resolve({ subject: 'id', email: null, emailVerified: false, displayName: null })
            },
          },
        ],
      },
    }),
  )
  plugin.messages = { en: { hello: 'Hello' }, 'zh-CN': { hello: '你好' } }
  await env.boot([plugin])
  await enable('a')
  await env.core.plugins.loginAuthorize('a', 'login', {
    state: 's',
    codeChallenge: 'c',
    redirectUri: 'https://skin.example.test/callback',
    locale: 'en',
  })
  await env.core.plugins.loginExchange('a', 'login', {
    query: { code: 'c' },
    codeVerifier: 'v',
    redirectUri: 'https://skin.example.test/callback',
    locale: 'en',
  })
  expect(seen).toEqual(['Hello', 'Hello'])
})

test('users.adjustScore 的 RPC 校验参数、永久 key，并接受任一语言的文案', async () => {
  const definition = definePlugin({
    capabilities: ['users.score'],
    routes: { 'GET /': { auth: 'public', handler: () => Promise.resolve(new Response()) } },
  })
  const plugin = official('a', definition)
  plugin.messages = { fr: { score: { reward: 'Récompense' }, ['🪙'.repeat(128)]: '上限' } }
  const actor = await env.actor()
  let accepted = false
  await env.boot([plugin], {
    plugins: {
      load: injected(async (_, context, rpc) => {
        const args = { uid: actor.uid, delta: 1, reason: 'score.reward', key: 'once' }
        const bad: Record<string, unknown>[] = [
          { uid: 0 },
          { uid: -1 },
          { uid: 1.1 },
          { uid: '1' },
          { uid: Number.MAX_SAFE_INTEGER + 1 },
          { delta: 0 },
          { delta: 1.1 },
          { delta: 2147483648 },
          { delta: -2147483648 },
          { delta: '1' },
          { reason: '' },
          { reason: 'missing' },
          { reason: 'score' },
          { reason: 1 },
          { reason: '🪙'.repeat(129) },
          { key: '' },
          { key: ' leading' },
          { key: 'trailing ' },
          { key: '\tkey' },
          { key: 'x'.repeat(256) },
          { key: 'a\0b' },
          // 不成对的代理项写进数据库会变成 U+FFFD
          { key: '\ud800' },
          { key: 'a\udc00' },
          { key: '🪙'.repeat(256) },
          { key: 1 },
        ]
        for (const patch of bad)
          await expect(rpc(context.invocationId, 'users.adjustScore', { ...args, ...patch })).rejects.toMatchObject({
            name: 'PluginCallRejected',
          })
        expect(
          await rpc(context.invocationId, 'users.adjustScore', {
            ...args,
            reason: '🪙'.repeat(128),
            key: '🪙'.repeat(255),
          }),
        ).toEqual({ status: 'applied', balance: 1 })
        accepted = true
        return { status: 200, statusText: 'OK', headers: [], body: null }
      }),
    },
  })
  await env.core.plugins.admin.enable(actor, 'a')
  await env.core.plugins.route(routeInput('/'))
  expect(accepted).toBe(true)
  expect(await env.db.selectFrom('score_transactions').select('plugin_id').execute()).toEqual([{ plugin_id: 'a' }])
  // 网页按它决定显示插件的文案还是"来自插件"：任一语言里有就算
  expect(env.core.plugins.hasMessage('a', 'score.reward')).toBe(true)
  expect(env.core.plugins.hasMessage('a', 'score')).toBe(false)
  expect(env.core.plugins.hasMessage('a', 'missing')).toBe(false)
  expect(env.core.plugins.hasMessage('gone', 'score.reward')).toBe(false)
})

test('user.registered 同一个事件重投两次只加一次积分', async () => {
  const statuses: string[] = []
  const plugin = official(
    'a',
    definePlugin({
      capabilities: ['users.score'],
      on: {
        'user.registered': async ({ ctx, event }) => {
          const result = await ctx.users.adjustScore(event.data.user.uid, 10, {
            reason: 'reward',
            key: `sharee:${event.data.user.uid}`,
          })
          statuses.push(result.status)
        },
      },
    }),
  )
  plugin.messages = { en: { reward: 'Reward' } }
  await env.boot([plugin])
  await enable('a')
  const { uid } = await env.core.users.register(env.input())
  const job = await env.db
    .selectFrom('jobs')
    .selectAll()
    .where('name', '=', 'plugin:a:on:user.registered')
    .executeTakeFirstOrThrow()
  const before = (await env.db.selectFrom('users').select('score').where('id', '=', uid).executeTakeFirstOrThrow())
    .score
  await env.core.jobs.drain()
  // 模拟至少一次投递：任务完成后用同一信封重新入队。
  await env.db
    .insertInto('jobs')
    .values({ name: job.name, payload: job.payload, run_at: job.run_at, created_at: job.created_at })
    .execute()
  await env.core.jobs.drain()
  expect(statuses).toEqual(['applied', 'duplicate'])
  expect((await env.db.selectFrom('users').select('score').where('id', '=', uid).executeTakeFirstOrThrow()).score).toBe(
    before + 10,
  )
  expect(await env.db.selectFrom('score_transactions').selectAll().where('plugin_id', '=', 'a').execute()).toHaveLength(
    1,
  )
})

test('registerFields 把 fromQuery 交给网页，旧声明默认为 false', async () => {
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        ui: {
          formFields: [
            { form: 'auth.register', field: { name: 'code', type: 'text', label: 'code' }, fromQuery: true },
            { form: 'auth.register', field: { name: 'note', type: 'textarea', label: 'note' } },
            { form: 'auth.register', field: { name: 'accept', type: 'boolean', label: 'accept' }, fromQuery: false },
          ],
        },
      }),
    ),
  ])
  await enable('a')
  expect(env.core.plugins.registerFields()).toEqual([
    { pluginId: 'a', field: { name: 'code', type: 'text', label: 'code' }, fromQuery: true },
    { pluginId: 'a', field: { name: 'note', type: 'textarea', label: 'note' }, fromQuery: false },
    { pluginId: 'a', field: { name: 'accept', type: 'boolean', label: 'accept' }, fromQuery: false },
  ])
})

const issueInput = { uid: 123, via: 'authenticate' as const }
const issueScope = { actor: { kind: 'user' as const, uid: 123, role: 'user' as const }, locale: 'en', ip: '192.0.2.1' }
const issueToken = () => env.core.plugins.interceptIssueToken(issueInput, issueScope)
const admissionInput = {
  phase: 'hasJoined' as const,
  serverKey: 'server-key-123456',
  uid: 123,
  pid: 456,
  playerUuid: 'a'.repeat(32),
  playerName: 'Steve',
  serverId: 'minecraft-server-id',
  ip: '192.0.2.1',
}
const admissionScope = { actor: { kind: 'user' as const, uid: 123, role: 'user' as const }, locale: 'en', ip: '192.0.2.1' }
const serverAdmission = () => env.core.plugins.interceptServerAdmission(admissionInput, admissionScope)

test('服务器准入没有插件时失败关闭', async () => {
  await env.boot([])
  await expect(serverAdmission()).resolves.toEqual({ action: 'unavailable' })
})

test('服务器准入拦截器收到路径和角色上下文，并可拒绝', async () => {
  const handler = vi.fn(({ input }: { input: CoreInterceptors['yggdrasil.serverAdmission']['input'] }) =>
    Promise.resolve(deny('server_banned', `denied:${input.serverKey}`)),
  )
  await env.boot([
    official('a', definePlugin({ capabilities: [], intercept: { 'yggdrasil.serverAdmission': handler } })),
  ])
  await enable('a')
  await expect(serverAdmission()).resolves.toMatchObject({ action: 'deny', plugin: 'a', reason: 'server_banned' })
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ input: admissionInput }))
})

test('签发拦截器放行、完整 scope、ctx.kv 在事务外可用', async () => {
  const handler = vi.fn()
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: ['storage.kv'],
        intercept: {
          'yggdrasil.issueToken': async ({ ctx, scope, input }) => {
            handler()
            expect(input).toEqual(issueInput)
            expect(scope).toEqual({ ...issueScope, requestId: expect.any(String) as string })
            expect(typeof ctx.fetch).toBe('function')
            await ctx.kv.set('checked', input.uid)
            expect(await ctx.kv.get('checked')).toBe(123)
          },
        },
      }),
    ),
  ])
  await enable('a')
  await expect(issueToken()).resolves.toEqual({ action: 'allow' })
  expect(handler).toHaveBeenCalledOnce()
})

test('准备签发拦截器的 scope 时读站点默认语言出错，按不可用处理、不调用插件', async () => {
  const handler = vi.fn()
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'yggdrasil.issueToken': handler } }))])
  await enable('a')
  const settings = env.core.settings
  const read = settings.read.bind(settings)
  vi.spyOn(settings, 'read').mockImplementation((async (keys: readonly string[]) => {
    if (keys.length === 1 && keys[0] === 'site.locale') throw new Error('settings unavailable')
    return read(keys as never)
  }) as typeof settings.read)
  await expect(env.core.plugins.interceptIssueToken(issueInput, { ...issueScope, locale: null })).resolves.toEqual({
    action: 'unavailable',
  })
  expect(handler).not.toHaveBeenCalled()
  expect(env.lines.some((line) => line.includes('intercept_failed yggdrasil.issueToken scope_error'))).toBe(true)
})

test('签发拒绝按码点截断 reason/message；priority、id 排序并短路', async () => {
  const order: string[] = []
  const plugin = (id: string, priority: number, blocked = false) =>
    official(
      id,
      definePlugin({
        capabilities: [],
        intercept: {
          'yggdrasil.issueToken': {
            priority,
            handler: () => {
              order.push(id)
              return Promise.resolve(blocked ? deny('🧩'.repeat(70), '🧩'.repeat(210)) : undefined)
            },
          },
        },
      }),
    )
  await env.boot([plugin('d', 20), plugin('b', 10, true), plugin('a', 10), plugin('c', 1)])
  await enable('a', 'b', 'c', 'd')
  await expect(issueToken()).resolves.toEqual({
    action: 'deny',
    plugin: 'b',
    reason: '🧩'.repeat(64),
    message: '🧩'.repeat(200),
  })
  expect(order).toEqual(['c', 'a', 'b'])
})

test.each(['throw', 'invalid', 'unavailable'] as const)(
  '签发拦截器 %s 失败关闭，三次后熔断；冷却后恢复',
  async (kind) => {
    const run = vi.fn<() => Promise<unknown>>(() =>
      kind === 'throw'
        ? Promise.reject(new Error('failure'))
        : kind === 'unavailable'
          ? Promise.reject(unavailableError())
          : Promise.resolve({ action: 'allow' }),
    )
    await env.boot(
      [official('a', definePlugin({ capabilities: [], intercept: { 'yggdrasil.issueToken': async () => {} } }))],
      {
        plugins: { load: injected(run) },
      },
    )
    await enable('a')
    for (let n = 0; n < 4; n++) await expect(issueToken()).resolves.toEqual({ action: 'unavailable' })
    expect(run).toHaveBeenCalledTimes(3)
    expect(env.lines.some((line) => line.includes('intercept:yggdrasil.issueToken'))).toBe(true)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now + 30_001)
    run.mockImplementation(() => Promise.resolve(null))
    await expect(issueToken()).resolves.toEqual({ action: 'allow' })
    expect(run).toHaveBeenCalledTimes(4)
  },
)

test('签发拦截器超时 2000ms，abort 后返回也不放行', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const entered = Promise.withResolvers<void>()
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        intercept: {
          'yggdrasil.issueToken': async ({ ctx }) => {
            entered.resolve()
            await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
          },
        },
      }),
    ),
  ])
  await enable('a')
  const result = issueToken()
  await entered.promise
  await vi.advanceTimersByTimeAsync(2000)
  await expect(result).resolves.toEqual({ action: 'unavailable' })
})

test('启用着却取不到包时注册、签发和用户操作都关闭', async () => {
  await env.boot([])
  await env.db
    .insertInto('plugins')
    .values({
      id: 'missing',
      version: '1.0.0',
      is_enabled: 1,
      capabilities: '[]',
      installed_at: toIsoTimestamp(new Date()),
      updated_at: toIsoTimestamp(new Date()),
    })
    .execute()
  await env.core.plugins.sync()
  const actor = await env.actor()
  await expect(env.core.plugins.interceptUserAction({ uid: actor.uid, action: 'player.create' })).resolves.toEqual({
    action: 'unavailable',
  })
  await expect(issueToken()).resolves.toEqual({ action: 'unavailable' })
  await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
})

test.each(['user.register', 'yggdrasil.issueToken', 'user.action'] as const)(
  '有 manifest 但激活失败时只关闭声明的 %s',
  async (name) => {
    await env.boot([
      official(
        'a',
        definePlugin({
          capabilities: [],
          jobs: { noop: { handler: async () => {} } },
          cron: [{ schedule: '99 * * * *', job: 'noop' }],
          intercept: { [name]: async () => {} },
        }),
      ),
    ])
    const time = toIsoTimestamp(new Date())
    await env.db
      .insertInto('plugins')
      .values({ id: 'a', version: '1.0.0', is_enabled: 1, capabilities: '[]', installed_at: time, updated_at: time })
      .execute()
    await env.core.plugins.sync()
    expect(env.core.plugins.isActive('a')).toBe(false)
    await expect(issueToken()).resolves.toEqual({ action: name === 'yggdrasil.issueToken' ? 'unavailable' : 'allow' })
    const actor = await env.actor()
    await expect(env.core.plugins.interceptUserAction({ uid: actor.uid, action: 'player.create' })).resolves.toEqual({
      action: name === 'user.action' ? 'unavailable' : 'allow',
    })
    const registration = env.core.users.register(env.input())
    if (name === 'user.register') await expect(registration).rejects.toMatchObject({ code: 'plugin_unavailable' })
    else await expect(registration).resolves.toMatchObject({ uid: expect.any(Number) as number })
  },
)

test('用户操作放行，scope 使用真实身份、用户语言和空 IP，ctx.kv 可在事务外使用', async () => {
  const handler = vi.fn()
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: ['storage.kv'],
        intercept: {
          'user.action': async ({ ctx, scope, input }) => {
            handler(input, scope)
            expect(typeof ctx.fetch).toBe('function')
            expect(ctx.jobs).toBeDefined()
            await ctx.kv.set('checked', input.uid)
            expect(await ctx.kv.get('checked')).toBe(input.uid)
          },
        },
      }),
    ),
  ])
  const actor = await enable('a')
  await env.db.updateTable('users').set({ locale: 'en' }).where('id', '=', actor.uid).execute()
  const input = { uid: actor.uid, action: 'texture.upload' }
  await expect(env.core.plugins.interceptUserAction(input)).resolves.toEqual({ action: 'allow' })
  expect(handler).toHaveBeenLastCalledWith(input, {
    requestId: expect.any(String) as string,
    actor: { kind: 'user', uid: actor.uid, role: 'superadmin' },
    locale: 'en',
    ip: '',
  })
  await env.db.updateTable('users').set({ locale: null }).where('id', '=', actor.uid).execute()
  const locale = (await env.core.settings.read(['site.locale']))['site.locale']
  await env.core.plugins.interceptUserAction(input)
  expect(handler).toHaveBeenLastCalledWith(input, expect.objectContaining({ locale, ip: '' }))
})

test('用户操作拒绝按码点截断 reason 和 message', async () => {
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        intercept: { 'user.action': () => Promise.resolve(deny('🧩'.repeat(70), '🧩'.repeat(210))) },
      }),
    ),
  ])
  const actor = await enable('a')
  await expect(env.core.plugins.interceptUserAction({ uid: actor.uid, action: 'player.create' })).resolves.toEqual({
    action: 'deny',
    plugin: 'a',
    reason: '🧩'.repeat(64),
    message: '🧩'.repeat(200),
  })
})

test.each(['throw', 'invalid', 'unavailable'] as const)(
  '用户操作 %s 失败关闭，连续三次熔断，冷却后恢复',
  async (kind) => {
    const run = vi.fn<() => Promise<unknown>>(() =>
      kind === 'throw'
        ? Promise.reject(new Error('failure'))
        : kind === 'unavailable'
          ? Promise.reject(unavailableError())
          : Promise.resolve({ action: 'patch', patch: {} }),
    )
    await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.action': async () => {} } }))], {
      plugins: { load: injected(run) },
    })
    const actor = await enable('a')
    const check = () => env.core.plugins.interceptUserAction({ uid: actor.uid, action: 'player.create' })
    for (let n = 0; n < 4; n++) await expect(check()).resolves.toEqual({ action: 'unavailable' })
    expect(run).toHaveBeenCalledTimes(3)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now + 30_001)
    run.mockResolvedValue(null)
    await expect(check()).resolves.toEqual({ action: 'allow' })
    expect(run).toHaveBeenCalledTimes(4)
  },
)

test('用户操作超时 2000ms，abort 后返回也不放行', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const entered = Promise.withResolvers<void>()
  await env.boot([
    official(
      'a',
      definePlugin({
        capabilities: [],
        intercept: {
          'user.action': async ({ ctx }) => {
            entered.resolve()
            await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
          },
        },
      }),
    ),
  ])
  const actor = await enable('a')
  const result = env.core.plugins.interceptUserAction({ uid: actor.uid, action: 'player.create' })
  await entered.promise
  await vi.advanceTimersByTimeAsync(2000)
  await expect(result).resolves.toEqual({ action: 'unavailable' })
})

test('用户操作没有拦截器时不读用户；有拦截器时读用户出错按不可用处理', async () => {
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.action': async () => {} } }))])
  const actor = await env.actor()
  const read = vi.spyOn(env.db, 'selectFrom')
  await expect(env.core.plugins.interceptUserAction({ uid: actor.uid, action: 'player.create' })).resolves.toEqual({
    action: 'allow',
  })
  expect(read).not.toHaveBeenCalled()
  read.mockRestore()
  await env.core.plugins.admin.enable(actor, 'a')
  vi.spyOn(env.db, 'selectFrom').mockImplementation(() => {
    throw new Error('database unavailable')
  })
  await expect(env.core.plugins.interceptUserAction({ uid: actor.uid, action: 'player.create' })).resolves.toEqual({
    action: 'unavailable',
  })
})

test('用户操作准备 scope 时读默认语言出错按不可用处理', async () => {
  const handler = vi.fn()
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.action': handler } }))])
  const actor = await enable('a')
  vi.spyOn(env.core.settings, 'read').mockRejectedValue(new Error('settings unavailable'))
  await expect(env.core.plugins.interceptUserAction({ uid: actor.uid, action: 'player.create' })).resolves.toEqual({
    action: 'unavailable',
  })
  expect(handler).not.toHaveBeenCalled()
})

test('封禁或不存在的用户不调用用户操作拦截器，按读到的状态直接报错', async () => {
  const handler = vi.fn()
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.action': handler } }))])
  const actor = await enable('a')
  await env.db.updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
  await expect(env.core.plugins.interceptUserAction({ uid: actor.uid, action: 'player.create' })).rejects.toMatchObject(
    {
      code: 'user_banned',
    },
  )
  await expect(
    env.core.plugins.interceptUserAction({ uid: actor.uid + 1000, action: 'player.create' }),
  ).rejects.toMatchObject({ code: 'unauthenticated' })
  await expect(env.core.players.create(actor, { name: 'Steve' })).rejects.toMatchObject({ code: 'user_banned' })
  await expect(env.core.players.create({ uid: actor.uid + 1000 }, { name: 'Steve' })).rejects.toMatchObject({
    code: 'unauthenticated',
  })
  expect(handler).not.toHaveBeenCalled()
})

test('读到封禁之后、事务之前被解封，添加角色仍被拒绝，不会绕过插件', async () => {
  const handler = vi.fn(() => Promise.resolve(deny('binding_required', '请先绑定')))
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.action': handler } }))])
  const actor = await enable('a')
  await env.db.updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
  // 用例在调用插件之后才开事务：开事务之前先解封，模拟管理员恰好在这之间操作
  const transaction = env.db.transaction.bind(env.db)
  vi.spyOn(env.db, 'transaction').mockImplementation(() => {
    const builder = transaction()
    return {
      execute: async (run: Parameters<typeof builder.execute>[0]) => {
        await env.db.updateTable('users').set({ role: 'user' }).where('id', '=', actor.uid).execute()
        return builder.execute(run)
      },
    } as typeof builder
  })
  await expect(env.core.players.create(actor, { name: 'Steve' })).rejects.toMatchObject({ code: 'user_banned' })
  expect(await env.db.selectFrom('players').select('id').where('user_id', '=', actor.uid).execute()).toEqual([])
  expect(handler).not.toHaveBeenCalled()
})

const userActions = [
  'player.create',
  'player.update',
  'player.delete',
  'texture.upload',
  'texture.update',
  'texture.delete',
  'report.create',
  'oauthClient.create',
  'oauthClient.update',
  'oauthClient.resetSecret',
  'oauthClient.delete',
] as const

test.each(userActions)('%s 在事务外被拒绝：不写入，封禁仍报 user_banned', async (action) => {
  const handler = vi.fn(() => Promise.resolve(deny('binding_required', '请先绑定')))
  const processUpload = vi.fn(() =>
    Promise.resolve({ png: new Uint8Array(100), pixelHash: 'a'.repeat(64), width: 64, height: 64 }),
  )
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.action': handler } }))], {
    imagePool: { processUpload, inspect: vi.fn(), render: vi.fn(), processSiteImage: vi.fn(), close: async () => {} },
  })
  vi.spyOn(env.core.renders, 'warm').mockImplementation(() => {})
  const actor = await env.actor()
  await env.db.updateTable('users').set({ score: 10000, email_verified: true }).where('id', '=', actor.uid).execute()
  const player = await env.core.players.create(actor, { name: 'Steve' })
  const upload = { bytes: new Uint8Array(1), name: 'Skin', type: 'steve' as const, public: true }
  const { texture } = await env.core.textures.upload(actor, upload)
  const { client } = await env.core.oauth.createClient(actor, {
    name: 'App',
    type: 'web',
    redirectUris: ['https://example.test/cb'],
  })
  await env.core.plugins.admin.enable(actor, 'a')
  processUpload.mockClear()
  const snapshot = async () => ({
    users: await env.db.selectFrom('users').selectAll().execute(),
    players: await env.db.selectFrom('players').selectAll().execute(),
    textures: await env.db.selectFrom('textures').selectAll().execute(),
    files: await env.db.selectFrom('texture_files').selectAll().execute(),
    closet: await env.db.selectFrom('closet_items').selectAll().execute(),
    reports: await env.db.selectFrom('reports').selectAll().execute(),
    clients: await env.db.selectFrom('oauth_clients').selectAll().execute(),
    score: await env.db.selectFrom('score_transactions').selectAll().execute(),
    jobs: await env.db.selectFrom('jobs').selectAll().execute(),
  })
  const calls = {
    'player.create': () => env.core.players.create(actor, { name: 'Alex' }),
    'player.update': () => env.core.players.update(actor, player.pid, { name: 'Alex' }),
    'player.delete': () => env.core.players.delete(actor, player.pid),
    'texture.upload': () => env.core.textures.upload(actor, upload),
    'texture.update': () => env.core.textures.update(actor, texture.tid, { name: 'Renamed' }),
    'texture.delete': () => env.core.textures.delete(actor, texture.tid),
    'report.create': () => env.core.reports.create(actor, { tid: texture.tid, reason: 'Report' }),
    'oauthClient.create': () => env.core.oauth.createClient(actor, { name: 'New', type: 'native', redirectUris: [] }),
    'oauthClient.update': () => env.core.oauth.updateClient(actor, client.id, { name: 'Renamed' }),
    'oauthClient.resetSecret': () => env.core.oauth.resetClientSecret(actor, client.id),
    'oauthClient.delete': () => env.core.oauth.deleteClient(actor, client.id),
  }
  const before = await snapshot()
  const transaction = vi.spyOn(env.db, 'transaction')
  await expect(calls[action]()).rejects.toMatchObject({
    code: 'action_denied',
    params: { plugin: 'a', reason: 'binding_required', message: '请先绑定' },
  })
  expect(transaction).not.toHaveBeenCalled()
  expect(handler).toHaveBeenCalledOnce()
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ input: { uid: actor.uid, action } }))
  expect(await snapshot()).toEqual(before)
  expect(processUpload).not.toHaveBeenCalled()
  handler.mockClear()
  await env.db.updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
  await expect(calls[action]()).rejects.toMatchObject({ code: 'user_banned' })
  expect(handler).not.toHaveBeenCalled()
})

test('衣柜、设备码确认、注册顺带建角色和后台代操作不调用 user.action', async () => {
  const handler = vi.fn(() => Promise.resolve(deny('blocked', '不允许')))
  await env.boot([official('a', definePlugin({ capabilities: [], intercept: { 'user.action': handler } }))], {
    imagePool: {
      processUpload: () =>
        Promise.resolve({ png: new Uint8Array(100), pixelHash: 'a'.repeat(64), width: 64, height: 64 }),
      inspect: vi.fn(),
      render: vi.fn(),
      processSiteImage: vi.fn(),
      close: async () => {},
    },
  })
  vi.spyOn(env.core.renders, 'warm').mockImplementation(() => {})
  const actor = await env.actor()
  await env.db.updateTable('users').set({ score: 10000, email_verified: true }).where('id', '=', actor.uid).execute()
  const { texture } = await env.core.textures.upload(actor, {
    bytes: new Uint8Array(1),
    name: 'Skin',
    type: 'steve',
    public: true,
  })
  const { client } = await env.core.oauth.createClient(actor, { name: 'App', type: 'native', redirectUris: [] })
  await env.core.plugins.admin.enable(actor, 'a')
  await env.core.closet.remove(actor, texture.tid)
  await env.core.closet.add(actor, { tid: texture.tid })
  await env.core.closet.rename(actor, texture.tid, { name: 'Renamed' })
  await env.db
    .insertInto('device_codes')
    .values({
      device_code: 'device',
      user_code: 'ABCDEFGH',
      user_id: String(actor.uid),
      status: 'pending',
      scope: 'openid profile',
      client_id: client.clientId,
      oauth_client_id: client.clientId,
      expires_at: writeAuthDate(env.db, toIsoTimestamp(new Date(Date.now() + 600000))),
    })
    .execute()
  await env.core.oauth.approveDevice(actor.uid, { userCode: 'ABCDEFGH', pid: null })
  expect(
    (
      await env.db
        .selectFrom('device_codes')
        .select('status')
        .where('device_code', '=', 'device')
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe('approved')
  const { uid } = await env.core.users.register(env.input())
  const player = await env.db.selectFrom('players').select('id').where('user_id', '=', uid).executeTakeFirstOrThrow()
  await env.core.admin.updatePlayer(actor, player.id, { name: 'Renamed' })
  expect(handler).not.toHaveBeenCalled()
})
