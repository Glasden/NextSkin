import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assetFigureDirectory,
  assetFigures,
  assetInstruction,
  readPng,
  type AssetFigureManifest,
} from '../test/cases.ts'
import { samePixels } from '../test/helpers.ts'
import { RENDERER_VERSION } from './index.ts'

const manifest = JSON.parse(readFileSync(new URL('manifest.json', assetFigureDirectory), 'utf8')) as AssetFigureManifest

describe('随核心发布的材质拼图', () => {
  const figures = assetFigures()
  it('渲染器版本和材质清单一致', () => {
    expect(manifest.rendererVersion, assetInstruction).toBe(RENDERER_VERSION)
    expect(manifest.figures, assetInstruction).toEqual(
      Object.fromEntries(figures.map(({ name, type, textureScale }) => [name, { type, textureScale }])),
    )
  })
  for (const { files } of figures) {
    for (const { file, render } of files) {
      it(file, () => {
        expect(samePixels(render(), readPng(new URL(file, assetFigureDirectory))), assetInstruction).toBe(true)
      })
    }
  }
})
