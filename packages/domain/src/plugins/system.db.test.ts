import { countRows, dialectOf } from '@nextskin/db'
import { loadPlugin, remoteDialect, type CoreRpc, type InvocationContext, type PluginCall } from '@nextskin/plugin-host'
import { definePlugin, deny, table } from '@nextskin/plugin-sdk'
import { Kysely } from 'kysely'
import { afterEach, expect, test, vi } from 'vitest'
import { DomainError } from '../errors.ts'
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

test('300 ms 超时回滚并释放写锁，停用后下一次注册立即完成', async () => {
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
  const next = performance.now()
  await env.core.plugins.admin.disable(actor, 'a')
  await env.core.users.register(env.input())
  expect(performance.now() - next).toBeLessThan(400)
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
  await env.boot([official('a', { ...recorder(), capabilities: ['storage.tables', 'storage.kv', 'users.read'] })], {
    plugins: {
      load: injected(async (_, context, rpc) => {
        for (const [method, args] of [
          ['kv.get', { key: 'key' }],
          ['fetch', { method: 'GET', url: 'https://api.example.test', headers: [], body: null }],
          ['jobs.enqueue', { name: 'missing', payload: {} }],
          ['users.get', { uid: 1 }],
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
  })
  await enable('a')
  await env.core.users.register(env.input())
  expect(denied).toEqual(['kv.get', 'fetch', 'jobs.enqueue', 'users.get'])
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
  await expect(pending).rejects.toMatchObject({ code: 'plugin_error' })
  expect(calls).toBe(0)
})
