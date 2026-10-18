// 从 BS v6 录制契约用例：pnpm --filter @nextskin/contract-tests record
// 先按 bs-v6/README.md 启动录制环境。脚本会清空 BS 里除超级管理员以外的用户、角色、材质和 UUID 映射，
// 写入 src/world.ts 描述的数据，再逐个发送 src/cases.ts 里的请求，结果写进 recordings/bs-v6.json。
// 场景每个开始前都重新写入数据库里的固定数据、清空缓存。
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cases, DEFAULT_HEADERS, scenarios } from '../src/cases.ts'
import type { RecordedResponse, Recording } from '../src/recording.ts'
import { runScenario, sendCase, sendHttp } from '../src/replay.ts'
import { ORIGIN } from '../src/world.ts'
import { assertSigningPublicKey, decodeTexturesValue, verifyPropertySignature } from '../src/yggdrasil.ts'
import { allocateUuids, clearCache, copyTextures, openBsDatabase, seedDatabase } from './bs-instance.ts'

const output = new URL('../recordings/bs-v6.json', import.meta.url)
const target = new URL(ORIGIN)

// 与 bs-v6/Dockerfile、compose.yaml 一致
const SOURCE = {
  bs: '6.0.2',
  plugins: { 'yggdrasil-api': '5.2.1', 'usm-api': '1.2.3', 'legacy-api': '1.1.3' },
}

const send = sendHttp(target)

function checkYggdrasil(id: string, response: RecordedResponse, publicKey: string): void {
  if (response.body.kind !== 'json') return
  const body = response.body.value as { properties?: { name: string; value: string; signature?: string }[] }
  for (const property of body.properties ?? []) {
    if (property.signature !== undefined && !verifyPropertySignature(property.value, property.signature, publicKey)) {
      throw new Error(`${id}：BS 的签名用它自己的公钥验证不通过`)
    }
    if (property.name === 'textures') decodeTexturesValue(property.value)
  }
}

const db = await openBsDatabase()
await seedDatabase(db, 'allocate')
copyTextures()
clearCache()
await allocateUuids(db, send)

const meta = await send({ method: 'GET', path: '/api/yggdrasil', headers: DEFAULT_HEADERS, body: '' })
if (meta.body.kind !== 'json') throw new Error('BS 的 /api/yggdrasil 没有返回 JSON')
const publicKey = assertSigningPublicKey((meta.body.value as { signaturePublickey?: unknown }).signaturePublickey)

const recording: Recording = {
  source: { ...SOURCE, recordedAt: new Date().toISOString() },
  cases: {},
  scenarios: {},
}
try {
  for (const contractCase of cases) {
    const response = await sendCase(send, contractCase)
    if (contractCase.body === 'yggdrasil-profile') checkYggdrasil(contractCase.id, response, publicKey)
    recording.cases[contractCase.id] = response
    console.log(`${String(response.status).padEnd(4)} ${contractCase.id}`)
  }
  for (const scenario of scenarios) {
    await seedDatabase(db, 'insert')
    clearCache()
    const responses: RecordedResponse[] = []
    await runScenario(send, scenario, (step, index, _request, response) => {
      if (step.body === 'yggdrasil-profile') checkYggdrasil(`${scenario.id} 第 ${index + 1} 步`, response, publicKey)
      responses.push(response)
    })
    recording.scenarios[scenario.id] = responses
    console.log(`${responses.map((response) => response.status).join(' ')}  ${scenario.id}`)
  }
} finally {
  await db.end()
}
writeFileSync(output, JSON.stringify(recording, null, 2) + '\n')
console.log(`已写入 ${fileURLToPath(output)}，共 ${cases.length} 个用例、${scenarios.length} 个场景`)
