import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, type Locator, type Page } from '@playwright/test'

// 授权码流程（ADR-0037 切片二）的 e2e 共用：登记应用、拼授权地址、接回调。connect.spec.ts 测流程本身，
// account.spec.ts 测两步验证、通行密钥登录以后回到授权流程

/** 启动器申请的 scope：选一个角色、用它进服、刷新令牌 */
export const CONNECT_SCOPE = 'openid offline_access Yggdrasil.PlayerProfiles.Select Yggdrasil.Server.Join'

/** 启动器那样的公共客户端：环回地址回调，登记时不写端口，请求时用随机端口（RFC 8252） */
const LOOPBACK_CALLBACK = 'http://127.0.0.1/callback'

/** account 服务的 SQLite 数据库（playwright.config.ts 给每个服务一个数据目录）。直接写表，测流程的用例不用每次都经过用户中心建应用 */
function database() {
  const directory = process.env.NEXTSKIN_E2E_ACCOUNT_DATA_DIR
  if (!directory) throw new Error('没有 account 服务的数据目录')
  const db = new DatabaseSync(join(directory, 'nextskin.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/** 登记一个公共客户端，创建者是 ownerEmail 的用户 */
export function createLauncherClient(ownerEmail: string, clientId: string) {
  const db = database()
  try {
    const owner = db.prepare('select id from users where email = ?').get(ownerEmail) as { id: number } | undefined
    if (!owner) throw new Error(`没有 ${ownerEmail}`)
    const now = new Date().toISOString()
    db.prepare(
      `insert into oauth_clients (client_id, name, user_id, redirect_uris, token_endpoint_auth_method, grant_types,
        response_types, disabled, created_at, updated_at) values (?, ?, ?, ?, 'none', ?, ?, 0, ?, ?)`,
    ).run(
      clientId,
      'E2E Launcher',
      owner.id,
      JSON.stringify([LOOPBACK_CALLBACK]),
      JSON.stringify(['authorization_code', 'refresh_token']),
      JSON.stringify(['code']),
      now,
      now,
    )
  } finally {
    db.close()
  }
}

/** 授权地址：PKCE（公共客户端必须带）、state，回调到 port 上的环回地址 */
export function authorization(clientId: string, port: number, scope: string = CONNECT_SCOPE) {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(8).toString('hex')
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })
  return { url: `/api/auth/oauth2/authorize?${params}`, params, verifier, state, redirectUri }
}

/**
 * 像启动器那样在环回地址上接回调（RFC 8252），端口由系统分配，页面关闭时停止监听。不用 page.route 拦：
 * 授权错误是 authorize 直接 302 到回调地址，page.route 只拦重定向链上的第一个地址
 */
export async function listenCallback(page: Page): Promise<number> {
  const server = createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>callback</title>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  page.once('close', () => server.close())
  return (server.address() as AddressInfo).port
}

export async function waitForCallback(page: Page, port: number): Promise<URLSearchParams> {
  await page.waitForURL((url) => url.origin === `http://127.0.0.1:${port}` && url.pathname === '/callback')
  return new URL(page.url()).searchParams
}

/**
 * 点同意页、批准页的按钮。按钮是服务端渲染的，React 接管之前点了没有反应，负载高时 Playwright 会抢在前面点。
 * React 水合一个元素时在它上面挂 `__reactProps$…`，等它出现再点
 */
export async function clickHydrated(button: Locator) {
  await expect
    .poll(() => button.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps$'))))
    .toBe(true)
  await button.click()
}
