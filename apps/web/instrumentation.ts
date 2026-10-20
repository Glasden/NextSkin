export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { subscribePeerAddress } = await import('./lib/peer-address')
    subscribePeerAddress()
    // 后台任务由核心进程执行（ADR-0021、ADR-0039）：启动时就打开核心，重启后积压的任务不用等第一个请求。
    // 构建时预渲染也会调用 register，那时不能连库
    if (process.env.NEXT_PHASE !== 'phase-production-build') {
      const { getServer, openedServer } = await import('./lib/server')
      const { connectLauncher } = await import('./lib/launcher-channel')
      const opening = getServer()
      // 失败时第一个请求会重试并返回错误；这里不输出异常，里面可能带着数据库地址（不变量 11）
      opening.catch(() => console.error('[core] open_failed'))
      connectLauncher(opening, openedServer)
    }
  }
}
