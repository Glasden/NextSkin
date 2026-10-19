# 路由

插件的 HTTP 入口在 `routes` 声明，用来提供数据源和处理交互。所有路径挂在 `/plugins/{插件id}` 下，界面如何调用它们见[界面](./ui.md)。

## 声明

```ts
import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  permissions: { refresh: 'permission.refresh' },
  routes: {
    'POST /refresh': {
      auth: 'user',
      permission: 'refresh',
      maxBodyBytes: 1024,
      rateLimit: { limit: 10, windowSec: 60, by: 'user' },
      async handler({ scope, ctx }) {
        ctx.log.info('手动刷新', { uid: scope.actor.uid })
        return Response.json({ message: ctx.t('refresh.done') })
      },
    },
  },
})
```

示例的文案键写在插件 locales 中。路由键为 `METHOD /path`，方法只有 GET、POST、PUT、PATCH、DELETE；例如 `DELETE /codes/:code`。参数段匹配 `:[A-Za-z][A-Za-z0-9]*`，固定段匹配 `[A-Za-z0-9._~-]+`。不接受空段和末尾斜杠，根路径 `/` 除外。键不含查询参数；在 handler 里从 `new URL(request.url).searchParams` 读取查询。HTTP 的 HEAD 按 GET 匹配，响应去掉 body。

handler 收到 `request: Request`、`params`、`scope`、`ctx`，必须返回 Response。params 是路径参数字符串记录。需要校验自己的参数和 JSON，不因声明了路由就自动有业务校验。

## 身份和权限

`auth: 'public'` 一律匿名，scope.actor 为 system；即使请求带站点会话也一样。后台或用户中心在服务端调用 public 数据源时也匿名。public 不能声明 permission，不能按 user 限流；若需要自己的令牌认证，使用自己的头（例如 X-Api-Key）并在 handler 校验。

`auth: 'user'` 只认站点会话 Cookie，scope.actor 为带 uid、role 的用户；未登录返回 401，被封禁返回 403。需要管理操作时声明 permission，它必须先在本插件 permissions 中定义；键匹配 `^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$`，值是说明文案键。第一版插件权限固定授予管理员和超级管理员，普通用户没有，未获权限返回 403。页面隐藏不能代替路由权限检查。

已登录的 user 路由，非 GET 请求必须带 Origin，且精确等于站点 URL 的 origin（未配置站点 URL 时取请求站点地址）；否则 403。HEAD、OPTIONS 视为安全方法。**当前 public 路由不做这项 Origin 检查**，也不会读取会话；不要用它承担依赖用户 Cookie 的操作。

HTTP 请求的 Cookie、Authorization、Proxy-Authorization 不转发给插件。其余请求头转发，包括自定义令牌头；身份只从 scope 读取。页面服务端调用 GET 数据源时只传 `Accept: application/json`，不能依赖浏览器的其他头。

## 限流、大小和失败

rateLimit 的 limit 和 windowSec 都是正安全整数。by 可为 ip 或 user，但 public 只能 ip。计数位于核心进程内的固定时间窗口，从首个请求开始；多实例各自计数。所有入口都计数，包括页面在服务端调用数据源。升级改变限额后使用新规则。超过限额返回 429，HTTP 响应有 Retry-After。

maxBodyBytes 是 0–10485760 的安全整数，默认 1048576（1 MiB），最大 10 MiB。请求体完整读入后才转发，超过上限返回 413；不要假定能边收边处理。响应体也完整缓冲，最多 10 MiB，不支持流式响应。

每次路由调用限 30 秒，包含准备上下文和缓冲响应。超时返回 504（plugin_timeout），插件抛错、无效 Response 或响应过大返回 502（plugin_error），host 不可用返回 503；没有路由返回 404。页面服务端数据源出错会显示“没能加载”。

界面上的表单和动作由浏览器发出，不跟随重定向，路由回 3xx 时这次操作按失败显示（见[界面](./ui.md)）。响应不能设置 Cookie；逐跳头和安全头由核心过滤。核心固定 CSP 为 `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`，并加 nosniff。返回 HTML 不能作为在站点源上运行脚本的入口。user 路由固定 `Cache-Control: no-store`；public 可自设缓存，否则也 no-store。
