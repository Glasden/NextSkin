import { defineProject } from 'vitest/config'
import { timeouts } from '../../vitest.shared.ts'

export default defineProject({
  test: {
    name: 'plugin-share-registration-link',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // *.db.test.ts 在 pnpm test 里只用 SQLite 跑；四种数据库见 vitest.db.config.ts
    ...timeouts,
    env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: 'sqlite' },
  },
})
