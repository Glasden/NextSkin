import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'db',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 在非 UTC 进程时区运行，暴露 mysql2 写入 datetime 时错误使用本地时间的回归。
    env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: 'sqlite' },
  },
})
