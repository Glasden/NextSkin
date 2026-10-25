import type { Core } from '@nextskin/domain'
import { expect, test, vi } from 'vitest'
import { allowedDuringMaintenance, classifyMaintenance, type MaintenanceClass } from './maintenance.ts'

const pages: Record<MaintenanceClass, string[]> = {
  open: ['/sign-in', '/sign-in/two-factor', '/maintenance', '/setup', '/setup/import', '/setup/import/progress'],
  protocol: ['/device', '/oauth/consent', '/oauth/error'],
  restricted: [
    '/',
    '/sign-up',
    '/sign-in/complete',
    '/forgot-password',
    '/user',
    '/user/players',
    '/admin/settings',
    '/skinlib',
    '/skinlib/1',
    '/sign-in-extra',
    '/sign-in/two-factor/extra',
    '/maintenance/extra',
    '/setupx',
    '/device/extra',
    '/devices',
    '/oauth/consent/extra',
    '/oauth/errorx',
    '/api/health',
  ],
}
const endpoints: Record<MaintenanceClass, string[]> = {
  open: [
    '/ads.txt',
    '/api/health',
    '/site-images/hash.png',
    '/render',
    '/render/hash/front',
    '/api/setup',
    '/api/setup/import/env',
    '/api/import/run',
    '/api/import/run/report.md',
    '/api/auth/sign-in/email',
    '/api/auth/two-factor/verify-totp',
    '/api/auth/two-factor/verify-backup-code',
    '/api/auth/passkey/generate-authenticate-options',
    '/api/auth/passkey/verify-authentication',
    '/api/auth/sign-out',
    '/api/external-login/plugin/provider',
    '/api/external-login/plugin/provider/callback',
  ],
  protocol: [
    '/api/yggdrasil',
    '/api/yggdrasil/authserver/authenticate',
    '/csl',
    '/csl/Alice.json',
    '/usm',
    '/usm/Alice',
    '/Alice.json',
    '/skin/Alice.png',
    '/cape/Alice.png',
    '/textures/hash',
    '/api/auth/oauth2/authorize',
    '/api/auth/device/code',
    '/api/auth/jwks',
    '/api/auth/.well-known/openid-configuration',
    '/api/user/device/approve',
  ],
  restricted: [
    '/ads.txt/extra',
    '/ads-txt',
    '/',
    '/api/user',
    '/api/players',
    '/api/register',
    '/plugins/example',
    '/plugins/example/game',
    '/api/auth/sign-up/email',
    '/api/auth/get-session',
    '/api/auth/request-password-reset',
    '/api/external-login/complete',
    '/api/external-login/plugin',
    '/api/external-login/plugin/provider/extra',
    '/api/external-login/plugin/provider/callback/extra',
    '/api/external-login/plugin//provider',
    '/api/healthz',
    '/api/health/extra',
    '/rendering',
    '/site-imagesx/hash.png',
    '/api/setupx',
    '/api/import/runner',
    '/api/auth/sign-in/email/extra',
    '/api/auth/sign-outx',
    '/api/auth/two-factor/verify-totpx',
    '/api/auth/passkey/verify-registration',
    '/api/yggdrasilx',
    '/cslx/Alice.json',
    '/usmx/Alice',
    '/nested/Alice.json',
    '/skin/Alice.jpg',
    '/cape/Alice.png/extra',
    '/skin/nested/Alice.png',
    '/texturesx/hash',
    '/api/auth/oauth2x/authorize',
    '/api/auth/devicex/code',
    '/api/auth/jwks/extra',
    '/api/auth/.well-knownx/discovery',
    '/api/user/devicex/approve',
    '/sign-in',
  ],
}
for (const [surface, classes] of [
  ['page', pages],
  ['endpoint', endpoints],
] as const)
  for (const [classification, paths] of Object.entries(classes))
    test.each(paths)(`${surface} %s → ${classification}，忽略尾斜杠`, (path) => {
      for (const suffix of ['', '/', '///']) expect(classifyMaintenance(surface, path + suffix)).toBe(classification)
    })

function setup() {
  const getSessionUser = vi.fn<Core['auth']['getSessionUser']>().mockResolvedValue(null)
  const core = { auth: { getSessionUser } } as unknown as Core
  const request = {
    path: '/user',
    headers: new Headers({ cookie: 'session=placeholder' }),
    root: 'https://example.test',
  }
  return { core, getSessionUser, request }
}

test('开放路径和不停游戏服务时直接放行，受限请求没带 Cookie 时直接拒绝，都不查询会话', async () => {
  const { core, getSessionUser, request } = setup()
  for (const block of [false, true]) {
    expect(await allowedDuringMaintenance(core, 'page', { ...request, path: '/sign-in' }, block)).toBe(true)
    expect(await allowedDuringMaintenance(core, 'endpoint', { ...request, path: '/api/health' }, block)).toBe(true)
    expect(await allowedDuringMaintenance(core, 'page', { ...request, headers: new Headers() }, block)).toBe(false)
  }
  expect(await allowedDuringMaintenance(core, 'page', { ...request, path: '/device' }, false)).toBe(true)
  expect(await allowedDuringMaintenance(core, 'endpoint', { ...request, path: '/api/yggdrasil' }, false)).toBe(true)
  expect(getSessionUser).not.toHaveBeenCalled()
})

test.each([null, 'banned', 'user', 'admin', 'superadmin'] as const)(
  '受限页面和停用的游戏服务只放行管理员会话：%s',
  async (role) => {
    const { core, getSessionUser, request } = setup()
    if (role)
      getSessionUser.mockResolvedValue({
        uid: 1,
        sessionId: 1,
        nickname: 'User',
        email: 'user@example.test',
        locale: null,
        role,
      })
    for (const [surface, path] of [
      ['page', '/user'],
      ['endpoint', '/api/players'],
      ['page', '/device'],
      ['endpoint', '/api/yggdrasil'],
    ] as const) {
      expect(await allowedDuringMaintenance(core, surface, { ...request, path }, true)).toBe(
        role === 'admin' || role === 'superadmin',
      )
      expect(getSessionUser).toHaveBeenLastCalledWith(request.headers, request.root)
    }
    expect(getSessionUser).toHaveBeenCalledTimes(4)
  },
)
