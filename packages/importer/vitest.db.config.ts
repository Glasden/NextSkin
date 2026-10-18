import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['sqlite', 'mysql', 'mariadb', 'postgres'].map((dialect) => ({
      test: {
        name: `db:${dialect}`,
        environment: 'node',
        include: ['src/**/*.db.test.ts'],
        testTimeout: 60_000,
        // 在非 UTC 进程时区运行，暴露按本地时区解释旧站时间的错误
        env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: dialect },
      },
    })),
  },
})
