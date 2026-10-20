import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'db',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 迁移类的用例要在库上跑一遍全部迁移，pnpm check 并行跑各包时会超过默认的 5 秒；test:db 的上限见 vitest.db.config.ts
    testTimeout: 30_000,
    // 在非 UTC 进程时区运行，暴露 mysql2 写入 datetime 时错误使用本地时间的回归。
    env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: 'sqlite' },
  },
})
