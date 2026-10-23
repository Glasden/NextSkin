import { describe, expect, it } from 'vitest'
import plugin from './index.ts'

describe('@nextskin/eslint-plugin', () => {
  it('recommended 是注册自身并开启全部十一条规则的 flat config 对象', () => {
    expect(plugin.meta.name).toBe('@nextskin/eslint-plugin')
    expect(Object.keys(plugin.rules)).toHaveLength(11)
    expect(Array.isArray(plugin.configs.recommended)).toBe(false)
    expect(plugin.configs.recommended.plugins?.nextskin).toBe(plugin)
    expect(plugin.configs.recommended.rules).toEqual(
      Object.fromEntries(Object.keys(plugin.rules).map((name) => [`nextskin/${name}`, 'error'])),
    )
  })

  it.each(Object.entries(plugin.rules))('%s 有中文说明、报错消息且不接受选项', (_name, rule) => {
    expect(rule.meta?.type).toBe('problem')
    expect(rule.meta?.docs?.description).toMatch(/[\u4e00-\u9fff]/)
    expect(rule.meta?.schema).toEqual([])
    const messages = Object.values(rule.meta?.messages ?? {})
    expect(messages.length).toBeGreaterThan(0)
    for (const message of messages) {
      expect(message).toMatch(/[\u4e00-\u9fff]/)
      expect(message).toMatch(/不变量|ADR-|AGENTS\.md/)
    }
  })
})
