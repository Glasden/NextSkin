import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'domain',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 认证测试每个用例要做好几次 scrypt、bcrypt、argon2，全是 CPU 密集的；pnpm check 让 lint、类型检查和测试并行，
    // CI 上单个用例会从本地的 0.5 秒拖到 5 秒以上
    testTimeout: 30_000,
    env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: 'sqlite' },
  },
})
