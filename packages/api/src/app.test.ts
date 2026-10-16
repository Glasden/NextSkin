import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'

describe('createApp', () => {
  it('不启动 Next 也能直接测端点', async () => {
    const res = await createApp().request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
