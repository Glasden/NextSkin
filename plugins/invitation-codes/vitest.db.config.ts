import { defineConfig } from 'vitest/config'

// 经过核心跑一遍插件：四种数据库上，插件的查询都要能通过网关（同 packages/domain/vitest.db.config.ts）
export default defineConfig({
  test: {
    projects: ['sqlite', 'mysql', 'mariadb', 'postgres'].map((dialect) => ({
      test: {
        name: `invitation-codes:${dialect}`,
        environment: 'node',
        include: ['src/**/*.db.test.ts'],
        testTimeout: 30_000,
        env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: dialect },
      },
    })),
  },
})
