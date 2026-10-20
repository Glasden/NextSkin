import { expect, test, vi } from 'vitest'
import { DomainError } from '@nextskin/domain'
import { setup } from '../../../domain/src/closet/test-support.ts'
import { createApp } from '../app.ts'

const env = setup()

test.each(['captcha_required', 'captcha_failed', 'captcha_unavailable'])(
  '注册核对 %s 拒绝时，不调用用例且库里没有新增数据',
  async (code) => {
    const app = createApp({ core: env.core })
    const before = await env.db().selectFrom('users').select('id').execute()
    const register = vi.spyOn(env.core.users, 'register')
    const createSession = vi.spyOn(env.core.auth, 'createSession')
    vi.spyOn(env.core.captcha, 'verify').mockRejectedValueOnce(new DomainError(code))
    const response = await app.request(
      'http://example.test/api/register',
      {
        method: 'POST',
        headers: { origin: 'http://example.test', 'content-type': 'application/json', 'x-captcha-response': 'token' },
        body: JSON.stringify({ email: 'new@example.test', password: 'a valid long password', playerName: 'NewPlayer' }),
      },
      { peer: '198.51.100.9' },
    )
    expect(response.status).toBe(code === 'captcha_required' ? 400 : code === 'captcha_failed' ? 403 : 503)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(register).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(await env.db().selectFrom('users').select('id').execute()).toEqual(before)
    for (const table of ['players', 'accounts', 'sessions', 'jobs'] as const)
      expect(await env.db().selectFrom(table).selectAll().execute()).toEqual([])
  },
)
