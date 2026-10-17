import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['sqlite', 'mysql', 'mariadb', 'postgres'].map((dialect) => ({
      test: {
        name: `db:${dialect}`,
        environment: 'node',
        include: ['src/**/*.db.test.ts'],
        // 同 vitest.config.ts：密码哈希是 CPU 密集的，四种数据库的项目还会并行跑
        testTimeout: 30_000,
        // 在非 UTC 进程时区运行，暴露 mysql2 写入 datetime 时错误使用本地时间的回归。
        env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: dialect },
      },
    })),
  },
})
