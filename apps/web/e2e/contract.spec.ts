import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cases } from '@nextskin/contract-tests/cases'
import { checkCase, loadRecording, sendHttp } from '@nextskin/contract-tests/replay'
import { expect, test } from '@playwright/test'

// 经过 Next standalone 回放全部协议契约用例：rewrite、Route Handler 和 Next 自己加的处理都不能改变协议响应
// （ADR-0003）。数据由 playwright.config.ts 在启动服务前写入；直接调 Hono 的回放见 tests/contract。
const recording = loadRecording()
const publicKey = readFileSync(join(process.env.NEXTSKIN_E2E_DATA_DIR!, 'signing-public-key.pem'), 'utf8')
const send = sendHttp(new URL('http://127.0.0.1:3100'))
const startedAt = Date.now()

for (const contractCase of cases) {
  test(`${contractCase.id}：${contractCase.title}`, async () => {
    const problems = await checkCase(send, contractCase, { recording, publicKey, startedAt })
    expect(problems, problems.join('\n')).toEqual([])
  })
}
