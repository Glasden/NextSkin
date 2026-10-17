// 发送一个用例并与录制结果比较。回放测试（直接调 Hono）、e2e（经过 Next standalone）共用；
// 录制脚本用 sendHttp 向 BS 发请求。
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { DEFAULT_HEADERS, isEtagCase, resolveRequest, type ContractCase, type ContractRequest } from './cases.ts'
import { compareResponse } from './compare.ts'
import { recordBody, recordHeaders, type RecordedResponse, type Recording } from './recording.ts'

export type Send = (request: Required<ContractRequest>) => Promise<RecordedResponse>

export function loadRecording(): Recording {
  return JSON.parse(readFileSync(new URL('../recordings/bs-v6.json', import.meta.url), 'utf8')) as Recording
}

/** 用 node:http 发请求：fetch 不让改 Host 头，也会自己处理 Content-Length */
export function sendHttp(target: URL): Send {
  return (input) =>
    new Promise((resolve, reject) => {
      const body = Buffer.from(input.body, 'utf8')
      const req = request(
        {
          host: target.hostname,
          port: target.port,
          method: input.method,
          path: input.path,
          headers: { ...input.headers, ...(body.length ? { 'content-length': String(body.length) } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const headers: [string, string][] = []
            for (let i = 0; i < res.rawHeaders.length; i += 2)
              headers.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!])
            resolve({
              status: res.statusCode!,
              headers: recordHeaders(headers),
              body: recordBody(res.headers['content-type'], Buffer.concat(chunks)),
            })
          })
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.end(body)
    })
}

/** ETag 用例先请求一次拿到 ETag，再按用例指定的形式放进 If-None-Match */
export async function sendCase(send: Send, contractCase: ContractCase): Promise<RecordedResponse> {
  let etag: string | undefined
  if (isEtagCase(contractCase)) {
    const first = await send({ method: 'GET', path: contractCase.etagFrom.path, headers: DEFAULT_HEADERS, body: '' })
    etag = first.headers.etag
  }
  return send(resolveRequest(contractCase, etag))
}

/** 返回不一致之处；空数组表示与 BS 一致 */
export async function checkCase(
  send: Send,
  contractCase: ContractCase,
  context: { recording: Recording; publicKey: string; startedAt: number },
): Promise<string[]> {
  const actual = await sendCase(send, contractCase)
  const expectedId = contractCase.deviation?.compareWith ?? contractCase.id
  const expected = context.recording.cases[expectedId]
  if (!expected) return [`没有 ${expectedId} 的录制结果；请运行 pnpm --filter @nextskin/contract-tests record`]
  return compareResponse(expected, actual, contractCase.body ?? 'exact', {
    publicKey: context.publicKey,
    timeWindow: { from: context.startedAt, to: Date.now() },
  })
}
