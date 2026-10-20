import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['sqlite', 'mysql', 'mariadb', 'postgres'].map((dialect) => ({
      test: {
        name: `db:${dialect}`,
        environment: 'node',
        include: ['src/**/*.db.test.ts'],
        // 四种库的项目并行跑，CI 上 MySQL 的迁移、建库会慢好几倍；四个包的 test:db 统一用这个上限
        testTimeout: 60_000,
        hookTimeout: 60_000,
        // 在非 UTC 进程时区运行，暴露 mysql2 写入 datetime 时错误使用本地时间的回归。
        env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: dialect },
      },
    })),
  },
})
