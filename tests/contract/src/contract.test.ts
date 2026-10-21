// 回放 BS v6 的录制结果：同样的数据、同样的请求，NextSkin 的响应必须与 BS 一致（不变量 1）。
// 不需要 Docker：直接调用 Hono 的 app.request()，数据库用 SQLite。经过 Next 的回放见 apps/web/e2e/contract.spec.ts。
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '@nextskin/api'
import type { CoreDatabase } from '@nextskin/db'
import { createTestDatabase, removeTestDirectory } from '@nextskin/db/testing'
import { createCore, createLocalTextureStorage } from '@nextskin/domain'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { cases, DEFAULT_HEADERS, scenarios } from './cases.ts'
import { recordBody, recordHeaders } from './recording.ts'
import { checkCase, checkScenario, loadRecording, type Send } from './replay.ts'
import { generateSigningKey, seedWorld } from './seed.ts'

const recording = loadRecording()
const startedAt = Date.now()
const secretKey = 'nextskin-contract-secret-0123456789'
let keys: ReturnType<typeof generateSigningKey>
let world: World

interface World {
  send: Send
  cleanup(): Promise<void>
}

/**
 * 登录间隔和 BS 一样从请求开始时计时。第一次登录要校验密码、签发令牌，负载高的 CI 上超过默认的 1 秒，
 * 下一步到的时候已经不在间隔内。录制时各步都在 1 秒内完成，回放两个节流场景时放大间隔，
 * 验证的仍是"间隔内被拒、换个 username 不受影响"和"signout 与 authenticate 共用节流"
 */
const loginIntervals: Record<string, number> = {
  'auth/authenticate-throttled': 60_000,
  'auth/signout-throttled': 60_000,
}

/** 一个写好固定数据的新核心实例。场景各用一个：令牌、节流、进服记录都不能从别的场景带过来 */
async function createWorld(loginIntervalMs?: number): Promise<World> {
  const directory = await mkdtemp(join(tmpdir(), 'nextskin-contract-'))
  const database = await createTestDatabase<CoreDatabase>()
  const textureDirectory = join(directory, 'textures')
  await seedWorld(database.db, { textureDirectory, secretKey, signingKey: keys.privateKey, loginIntervalMs })
  const core = createCore({
    db: database.db,
    textureStorage: createLocalTextureStorage(textureDirectory),
    secretKey,
    production: false,
  })
  const app = createApp({ core })
  return {
    send: async (request) => {
      const host = request.headers.host ?? DEFAULT_HEADERS.host!
      const response = await app.request(`http://${host}${request.path}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      })
      return {
        status: response.status,
        headers: recordHeaders(response.headers.entries()),
        body: recordBody(
          response.headers.get('content-type') ?? undefined,
          new Uint8Array(await response.arrayBuffer()),
        ),
      }
    },
    async cleanup() {
      try {
        await core.shutdown()
        await database.cleanup()
      } finally {
        await removeTestDirectory(directory)
      }
    },
  }
}

beforeAll(async () => {
  keys = generateSigningKey()
  world = await createWorld()
}, 60_000)

afterAll(async () => {
  await world?.cleanup()
})

test('录制结果与用例一一对应（改了用例要重新录制）', () => {
  expect(Object.keys(recording.cases).sort()).toEqual(cases.map((contractCase) => contractCase.id).sort())
  expect(Object.keys(recording.scenarios).sort()).toEqual(scenarios.map((scenario) => scenario.id).sort())
})

describe.each(cases)('$id：$title', (contractCase) => {
  test('与 BS v6 一致', async () => {
    const problems = await checkCase(world.send, contractCase, {
      recording,
      publicKey: keys.publicKey,
      startedAt,
    })
    expect(problems, problems.join('\n')).toEqual([])
  })
})

describe.each(scenarios)('$id：$title', (scenario) => {
  test('每一步都与 BS v6 一致', async () => {
    const fresh = await createWorld(loginIntervals[scenario.id])
    try {
      const problems = await checkScenario(fresh.send, scenario, { recording, publicKey: keys.publicKey, startedAt })
      expect(problems, problems.join('\n')).toEqual([])
    } finally {
      await fresh.cleanup()
    }
  }, 30_000)
})
