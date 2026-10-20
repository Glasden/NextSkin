import { defineProject } from 'vitest/config'
import { timeouts } from '../../vitest.shared.ts'

export default defineProject({
  test: {
    name: 'importer',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    ...timeouts,
    // 导入要解码材质、核对 bcrypt，比别的包慢
    testTimeout: 60_000,
    env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: 'sqlite' },
  },
})
