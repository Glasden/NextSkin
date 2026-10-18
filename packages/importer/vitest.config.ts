import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'importer',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 导入要解码材质、核对 bcrypt，pnpm check 并行跑时单个用例会被拖慢
    testTimeout: 60_000,
    env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: 'sqlite' },
  },
})
