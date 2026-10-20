// 各包 vitest 配置共用的超时上限。pnpm check 经 turbo 并行跑所有包的 lint、类型检查和测试，CI 上 CPU 吃紧，
// 起子进程、哈希密码、跑迁移的用例常常超过默认的 5 秒（钩子 10 秒）。test:db 另有上限，见各包的 vitest.db.config.ts
export const timeouts = { testTimeout: 30_000, hookTimeout: 30_000 }
