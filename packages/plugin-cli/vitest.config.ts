import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'plugin-cli',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 每个用例都起 Node 进程，加载 rolldown、SDK 和 zod；pnpm check 并行跑各包测试时，参数错误的用例也超过过默认的 5 秒
    testTimeout: 30_000,
  },
})
