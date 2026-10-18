import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-invitation-codes',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // *.db.test.ts 在 pnpm test 里只用 SQLite 跑；四种数据库见 vitest.db.config.ts
    testTimeout: 30_000,
    env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: 'sqlite' },
  },
})
