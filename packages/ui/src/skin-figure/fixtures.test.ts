import { RENDERER_VERSION } from '@nextskin/skin'
import { expect, test } from 'vitest'
import { fixtureRendererVersion } from './fixtures.ts'

test('story 用的拼图和当前的渲染器是同一个版本', () => {
  expect(
    fixtureRendererVersion,
    '渲染器升级了，story 的拼图还是旧的：运行 pnpm --filter @nextskin/ui skin:fixtures',
  ).toBe(RENDERER_VERSION)
})
