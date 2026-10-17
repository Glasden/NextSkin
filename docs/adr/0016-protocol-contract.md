# ADR-0016 协议契约：以录制结果为判据，哪些 BS 行为不复现

- 状态：已采纳
- 日期：2026-10-17

## 背景

ADR-0001 要求 Minecraft 协议与 BS v6 严格兼容，并以录制自真实 BS v6 的契约用例为唯一判据。第 3 步实现只读协议端点时发现，BS 的协议响应里混着大量 Laravel 和 PHP 的副产品：

- 错误时渲染的 HTML 页面，内容随语言、`Accept` 头变化；`Accept: application/json` 时连 `Cache-Control` 都不同；
- 每个响应都写一个语言 Cookie；
- 输入经过 TrimStrings、ConvertEmptyStringsToNull 中间件和 PHP 的查询串解析、`array_unique`、`strtotime`；
- 名字和 UUID 的比较用 MySQL 的 `utf8mb4_unicode_ci`，除了大小写，还折叠重音、全角字符、`ſ` 这类兼容字符，并忽略末尾空格；
- 路由先把路径百分号解码再匹配；
- usm-api 1.2.3 的 `/usm/textures/{hash}` 指向了不存在的控制器，返回 500。

"严格兼容"如果包括这些全部，就得在 Node 里重写半个 Laravel；如果随手挑着复现，下一个人又会重新争论。需要一条规则。

## 决定

### 判据

- 协议行为以 `tests/contract` 的录制结果为准，比对规则见 `tests/contract/README.md`：状态码一律比较；影响客户端解码、缓存和发现 API 的响应头逐个比较；响应体按 JSON 深比较或按字节比较，Yggdrasil 的签名、公钥、时间戳、实现名和错误文案按语义比较。
- 改动协议行为之前，先在 `cases.ts` 加用例并从 BS v6 录制。录制结果的 diff 就是协议行为的变化。
- 回放既直接调 Hono（`pnpm check` 里），也经过 Next standalone（`pnpm e2e` 里）。

### 复现：客户端可能依赖的行为，哪怕看起来像 bug

只要真实的模组、启动器、游戏服务器或 CDN 会遇到，就复现，并录制用例守着。包括：名字查找忽略末尾空格、带点号的角色名 404、批量查询返回请求里的名字、被封禁用户的 Yggdrasil 资料照常返回、`unsigned` 的取值规则、TrimStrings 和 PHP 查询串的语义、批量查询按 `array_unique` 计数、Symfony 5.4.1 的条件请求规则、错误响应的缓存头、405 与 `Allow`、OPTIONS、HEAD 不带公开缓存头、ALI 头的有无和取值、按 `Host` 和 `X-Forwarded-Proto` 计算的站点地址。具体清单在 `tests/contract/README.md`。

### 不复现：只有异常输入才会触发、或复现了反而有害的行为

| 行为 | 理由 |
|---|---|
| Laravel 错误页的内容、`Content-Type`、`ETag` | 客户端只看状态码。状态码、`Cache-Control`、ALI 头照样比较 |
| `Accept: application/json` 时不同的错误响应（404 不带 `no-cache`，等于把 404 公开缓存） | 模组和启动器用 Java 默认的 Accept；复现等于复现一个缓存 bug |
| 错误响应上的条件请求（`If-None-Match: *` 让 404 变成 304） | GET 上没有客户端会这样发；复现会让 CDN 缓存"未修改的 404" |
| 语言 Cookie | 协议客户端不用；带 Cookie 的响应还会被一些 CDN 拒绝缓存 |
| `/usm/textures/{hash}` 返回 500 | 插件的 bug，按 `/textures/{hash}` 处理（用例里标为 `deviation`） |
| `utf8mb4_unicode_ci` 除大小写以外的折叠（重音、全角、兼容字符），以及对 UUID 的折叠 | 扩展 ADR-0015 已经接受的"不忽略重音"：正版角色名只有 ASCII，UUID 是十六进制 |
| 编码过的普通字符和路径分隔符（`%2E`、`%63`、`/csl%2FSteve.json`）、连续多个末尾斜杠 | BS 先解码再匹配路由，Next 的 rewrite 和 Hono 按原始路径匹配；客户端不会这样编码。路由参数里解码出 `/` 时返回 404，与 BS 相同 |
| `strtotime` 能解析、但不是 HTTP 日期的格式（`@时间戳`、相对日期；asctime 被 BS 按 Asia/Shanghai 解析） | 只认 IMF-fixdate 和 RFC 850，其余视为无法解析，返回完整响应。这样结果不取决于进程时区 |
| 批量查询请求体里的非字符串元素：数字和 `false` 在 MySQL 上与名字比较时被转成数字，`0 = 'Steve'` 成立，于是查到任意一个角色；嵌套数组和空对象让 BS 返回 500 | 异常输入。这些元素照样计入上限，但不查询 |
| 磁盘上有文件、表里没有记录的材质 | NextSkin 只认 `texture_files` 里 `active` 的行 |
| 角色第一次被 Yggdrasil 查询时才分配 UUID | ADR-0015：创建角色时就分配 |

### 新发现的差异

先录制，再按上面两条原则归类。归入"不复现"的写进 `tests/contract/README.md` 的差异清单，并说明属于上表的哪一类；不属于任何一类的，要先改本 ADR（另写一份取代它）。

## 后果

- 契约用例同时是 BS 行为的文档：读 `cases.ts` 和录制结果，就知道一个协议端点在各种输入下的行为。
- 复现 PHP 的输入语义让 `packages/api` 里多了一些看起来奇怪的代码（`phpTrim`、查询串取最后一个值、`array_unique` 式的计数），它们旁边都要注明对应的用例。
- 录制环境（`tests/contract/bs-v6`）要长期保留：协议行为有疑问时，先在 BS 上复现。
- 将来写 Yggdrasil 的认证、进服、上传端点时，同样先录制；需要令牌的用例要在录制脚本里先登录。

## 考虑过的其他方案

- **逐字节复现，包括错误页**：要复刻 Laravel 的视图、语言包和异常渲染，换来的兼容性没有客户端用得上。
- **只比较状态码和成功响应的 JSON**：缓存头、ALI 头、条件请求这些真实影响 CDN 和启动器的行为就没人守了。
