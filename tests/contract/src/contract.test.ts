// 回放 BS v6 的录制结果：同样的数据、同样的请求，NextSkin 的响应必须与 BS 一致（不变量 1）。
// 不需要 Docker：直接调用 Hono 的 app.request()，数据库用 SQLite。经过 Next 的回放见 apps/web/e2e/contract.spec.ts。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '@nextskin/api'
import type { CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { createCore, createLocalTextureStorage } from '@nextskin/domain'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { cases, DEFAULT_HEADERS } from './cases.ts'
import { recordBody, recordHeaders } from './recording.ts'
import { checkCase, loadRecording, type Send } from './replay.ts'
import { generateSigningKey, seedWorld } from './seed.ts'

const recording = loadRecording()
const startedAt = Date.now()
let database: TestDatabase<CoreDatabase>
let directory: string
let publicKey: string
let send: Send

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nextskin-contract-'))
  database = await createTestDatabase<CoreDatabase>()
  const keys = generateSigningKey()
  publicKey = keys.publicKey
  const secretKey = 'nextskin-contract-secret-0123456789'
  const textureDirectory = join(directory, 'textures')
  await seedWorld(database.db, { textureDirectory, secretKey, signingKey: keys.privateKey })
  const core = createCore({
    db: database.db,
    textureStorage: createLocalTextureStorage(textureDirectory),
    secretKey,
    production: false,
  })
  const app = createApp({ core })
  send = async (request) => {
    const host = request.headers.host ?? DEFAULT_HEADERS.host!
    const response = await app.request(`http://${host}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    })
    return {
      status: response.status,
      headers: recordHeaders(response.headers.entries()),
      body: recordBody(response.headers.get('content-type') ?? undefined, new Uint8Array(await response.arrayBuffer())),
    }
  }
}, 60_000)

afterAll(async () => {
  await database?.cleanup()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('录制结果与用例一一对应（改了用例要重新录制）', () => {
  expect(Object.keys(recording.cases).sort()).toEqual(cases.map((contractCase) => contractCase.id).sort())
})

describe.each(cases)('$id：$title', (contractCase) => {
  test('与 BS v6 一致', async () => {
    const problems = await checkCase(send, contractCase, { recording, publicKey, startedAt })
    expect(problems, problems.join('\n')).toEqual([])
  })
})
