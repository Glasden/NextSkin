import { defineConfig } from 'vitest/config'

// 经过核心跑一遍插件：四种数据库上，插件的查询都要能通过网关（同 packages/domain/vitest.db.config.ts）
export default defineConfig({
  test: {
    projects: ['sqlite', 'mysql', 'mariadb', 'postgres'].map((dialect) => ({
      test: {
        name: `share-registration-link:${dialect}`,
        environment: 'node',
        include: ['src/**/*.db.test.ts'],
        // 四种库的项目并行跑，CI 上 MySQL 的迁移、建库会慢好几倍；四个包的 test:db 统一用这个上限
        testTimeout: 60_000,
        hookTimeout: 60_000,
        env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: dialect },
      },
    })),
  },
})
