import { captureLogs } from '@nextskin/logging'
import { expect, test, vi } from 'vitest'
import type { createSettingQueries } from '../settings/queries.ts'
import * as parser from './head.ts'
import { createCustomCode } from './service.ts'

test('page 每次读设置，只在页头原文变化时解析；CSS 的变化立即可见', async () => {
  const values = { 'custom.head': '<script>first()</script>', 'custom.css': 'body {}' }
  const read = vi.fn().mockImplementation(() => Promise.resolve({ ...values }))
  const settings = { read } as Pick<ReturnType<typeof createSettingQueries>, 'read'>
  const parse = vi.spyOn(parser, 'parseHeadCode')
  try {
    const service = createCustomCode(settings)
    const first = await service.page()
    expect(first).toEqual({ head: [{ kind: 'script', attributes: { data: {} }, code: 'first()' }], css: 'body {}' })
    values['custom.css'] = 'html {}'
    const next = await service.page()
    expect(next.head).toBe(first.head)
    expect(next.css).toBe('html {}')
    expect(parse).toHaveBeenCalledTimes(1)
    values['custom.head'] = '<meta name="verify" content="test">'
    expect((await service.page()).head).toEqual([{ kind: 'meta', name: 'verify', content: 'test' }])
    expect(parse).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenLastCalledWith(['custom.head', 'custom.css'])
  } finally {
    parse.mockRestore()
  }
})

test('存着的不合法代码返回空数组，按原文缓存失败；日志不含代码或属性值', async () => {
  const values = { 'custom.head': '<script type="SECRET_CANARY">private()</script>', 'custom.css': 'body {}' }
  const settings = { read: () => Promise.resolve(values) } as Pick<ReturnType<typeof createSettingQueries>, 'read'>
  const logs = captureLogs()
  try {
    const service = createCustomCode(settings)
    expect(await service.page()).toEqual({ head: [], css: 'body {}' })
    expect(await service.page()).toEqual({ head: [], css: 'body {}' })
    expect(logs.records).toHaveLength(1)
    expect(logs.records[0]).toMatchObject({ level: 'warn', area: 'custom-code' })
    expect(JSON.stringify(logs.records)).not.toMatch(/SECRET_CANARY|private\(\)|<script/)
    values['custom.head'] = '<script>fixed()</script>'
    expect((await service.page()).head).toEqual([{ kind: 'script', attributes: { data: {} }, code: 'fixed()' }])
  } finally {
    logs.restore()
  }
})
