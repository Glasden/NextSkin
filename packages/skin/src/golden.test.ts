import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { goldenCases, goldenDirectory, goldenInstruction, readPng, type GoldenManifest } from '../test/cases.ts'
import fixtures from '../test/fixtures/manifest.json' with { type: 'json' }
import { samePixels } from '../test/helpers.ts'
import { RENDERER_VERSION } from './index.ts'

const manifest = JSON.parse(readFileSync(new URL('manifest.json', goldenDirectory), 'utf8')) as GoldenManifest
const cases = goldenCases()

describe('黄金图与渲染器版本', () => {
  it('版本与用例清单必须匹配', () => {
    expect(manifest.version, goldenInstruction).toBe(RENDERER_VERSION)
    expect(manifest.files, goldenInstruction).toEqual(cases.map(({ name }) => name))
  })
  for (const { name, render } of cases) {
    it(name, () => {
      expect(samePixels(render(), readPng(new URL(name, goldenDirectory))), `${name}：${goldenInstruction}`).toBe(true)
    })
  }
})

describe('真实材质来自 S4 的固定文件', () => {
  for (const [name, sha256] of Object.entries(fixtures)) {
    it(name, () => {
      const bytes = readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256)
    })
  }
})
