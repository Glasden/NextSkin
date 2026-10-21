# 任务和定时任务

需要重试、延迟执行或定期运行的工作，在 `jobs` 声明，用 `ctx.jobs.enqueue` 触发；按时间触发再加 `cron`。不要在入口顶层启动定时器。

## 声明和入队

```ts
import { definePlugin, z } from '@nextskin/plugin-sdk'

const payloadSchema = z.object({ key: z.string().min(1) })

export default definePlugin({
  capabilities: ['storage.kv'],
  jobs: {
    expire: {
      maxAttempts: 5,
      timeoutMs: 60_000,
      async handler({ payload, attempt, ctx }) {
        const { key } = payloadSchema.parse(payload)
        await ctx.kv.delete(key)
        ctx.log.info('已清理', { attempt })
      },
    },
  },
  routes: {
    'POST /expire': {
      auth: 'user',
      async handler({ request, ctx }) {
        const parsed = payloadSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return Response.json({ error: 'invalid key' }, { status: 400 })
        await ctx.jobs.enqueue('expire', parsed.data, { delaySec: 60, dedupeKey: parsed.data.key })
        return Response.json({ queued: true }, { status: 202 })
      },
    },
  },
})
```

任务名匹配 `^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$`，最多 64 字符。完整任务名 `plugin:{id}:job:{name}` 不能超过 128 字符，构建时检查。maxAttempts 为 1–20 的安全整数，默认 5（总尝试次数，含第一次）；timeoutMs 为 1–600000 的安全整数，默认 60000 毫秒。

handler 参数是 `{ payload: Json, attempt: number, ctx }`；attempt 从 1 开始。payload 是你自己定义的数据，读取时校验，不能因为有 TypeScript 就信任持久数据。

入队方法 `ctx.jobs.enqueue(name, payload, options?)` 返回 Promise<void>。name 必须已声明在自己 jobs 中。payload 序列化后最多 64 KiB，delaySec 为 0–2592000 的整数，默认 0。dedupeKey 按 Unicode 码点计 1–255 字符，无首尾空白、NUL 和不成对的代理项；同名任务同键在未完成期间只保留一份，返回值不区分是否新入队。任务完成或进入死信后键不再占用，不能当永久幂等键。

## 执行、重试和死信

任务至少执行一次，可能重复，必须幂等。上例删除不存在的 KV 也成功，所以重复没有副作用；付费接口等外部操作要用业务幂等键，不能只依赖入队去重。

handler 正常返回即成功；抛错、超时按失败处理，ctx.signal 到期 abort，核心不再接受迟到结果。退避为 `min(10000 × 2^(attempt-1), 3600000) × (0.8 + 0.4 × random)` 毫秒，四舍五入；即基础 10 秒起指数增长、基础最多 1 小时，随后加±20%抖动。超过 maxAttempts 进死信。进程退出时已认领的尝试也计数；host 不可用则暂停认领，已送达但因 host 退出而延期的任务放回队列且退回这次尝试。

后台 `/admin/plugins/{id}` 列出此插件的死信，可重试或删除。重试从 0 次开始，同去重键已有排队任务时丢掉这条重复死信。死信保留期 30 天。插件停用保留任务，重新启用继续；卸载会清理任务和死信。异常消息会写进 last_error，最多 500 字符，不要放机密。

## cron

在上例的 definePlugin 对象里加：

```ts
cron: [{ schedule: '0 3 * * *', job: 'expire', payload: { key: 'daily-cache' } }]
```

schedule 必须五段：分钟、小时、日、月、星期。可用常规的 `*`、列表（`1,15`）、范围（`1-5`）、步长（`*/10`）；不用六段秒表达式。构建时检查五段，安装前核心还检查表达式能解析、有下一次执行时间。job 必须是 jobs 里的键。

按站点时区解释，没有插件单独的 timezone 字段；站点时区或表达式变更时重新计算下一次执行。日和星期都限定时取“或”。停机错过多次只补一次；该条定时任务上一次还在队列里或执行中，这次跳过。夏令时拨快跳过的时刻顺延执行一次，拨慢重复的时刻只在第一次执行。

payload 没写时传 `{}`；显式 `null` 原样传，不替换成空对象。cron 引用同一套任务处理函数和重试机制，载荷也要自行校验。

[cdn-refresh](https://github.com/Glasden/NextSkin/tree/main/plugins/cdn-refresh) 展示路由先入队、后台任务再调用外部服务的做法。
