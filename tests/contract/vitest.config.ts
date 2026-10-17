import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'contract',
    environment: 'node',
    // 在非 UTC 时区运行，暴露按本地时间生成 Last-Modified 之类的错误
    env: { TZ: 'Asia/Shanghai', NEXTSKIN_TEST_DB: 'sqlite' },
  },
})
