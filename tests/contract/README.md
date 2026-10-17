# 协议契约测试

Minecraft 协议（CSL / USM / Legacy / Yggdrasil）以真实 BS v6 的行为为唯一判据（ADR-0001、不变量 1）。这里的用例从 BS v6 录制，回放时在 NextSkin 上发同样的请求，比较响应。

| 命令 | 用途 |
|---|---|
| `pnpm --filter @nextskin/contract-tests test` | 回放。不需要 Docker：直接调 Hono 的 `app.request()`，数据库用 SQLite。`pnpm check` 和 `pnpm test:contract` 都会跑 |
| `pnpm --filter @nextskin/contract-tests record` | 重新录制。先按 `bs-v6/README.md` 启动录制环境 |
| `pnpm e2e` | 也会经过 Next standalone 回放全部用例（`apps/web/e2e/contract.spec.ts`）：rewrite 和 Next 自己的处理都不能改变协议响应 |
| `node tests/contract/scripts/make-textures.ts` | 重新生成材质文件和清单。只在增删材质时运行，之后必须重新录制 |

## 目录

| 路径 | 内容 |
|---|---|
| `src/world.ts` | 固定数据：用户、材质、角色、UUID 映射、站点设置。录制时写进 BS，回放时写进 NextSkin |
| `src/cases.ts` | 用例：只写请求和比对方式 |
| `recordings/bs-v6.json` | 录制结果，由脚本生成，不要手改 |
| `src/compare.ts` | 比对规则 |
| `src/replay.ts` | 发送用例、与录制结果比较；回放测试、e2e、录制脚本共用 |
| `src/seed.ts` | 按 `docs/schema.md` 的导入对照把固定数据写进 NextSkin |
| `scripts/seed-sqlite.ts` | 把固定数据写进一个新的数据目录，e2e 用它启动 Next |
| `fixtures/textures/` | 材质文件（提交进仓库：文件字节随 zlib 版本变化，重新生成会改变 hash） |
| `bs-v6/` | 录制环境 |

## 录制

`scripts/record.ts` 清空 BS 里除超级管理员以外的用户、角色、材质、衣柜和 UUID 映射，写入 `world.ts` 的数据（BS 的 datetime 按 Asia/Shanghai 写入，材质文件的修改时间设为固定值），清缓存，然后：

1. 对 `bsUuidRow: 'v3'` 的角色先查一次 Yggdrasil，让 yggdrasil-api 分配 UUID，再核对分配结果等于 `world.ts` 里按离线算法算出的值；
2. 逐个发送用例的请求，用 BS 自己的公钥验证签名，写入 `recordings/bs-v6.json`。

改了 `world.ts` 或 `cases.ts` 就要重新录制；回放测试会检查用例和录制结果一一对应。录制结果的 diff 要逐条看：它就是协议行为的变化。

请求默认带 Java `HttpURLConnection` 的 Accept（CustomSkinLoader、authlib 都不改它）和 `Host: 127.0.0.1:38080`。

## 比对规则

哪些 BS 行为复现、哪些不复现，原则见 ADR-0016。比对规则在 `src/compare.ts`，它自己的测试在 `src/compare.test.ts`：

- **状态码**一律比较。
- **响应头**比较 `Content-Type`、`Content-Encoding`、`Cache-Control`、`ETag`、`Last-Modified`、`X-Authlib-Injector-API-Location`、`Allow`、`Location`：值必须相同，BS 没有的 NextSkin 也不能有。其余响应头不比较（`Content-Length`、`Date`、Next 加的 `Vary` 属于传输层；BS 给每个响应写的语言 Cookie 不复现）。
- **响应体**：
  - JSON 解析后深比较，键的顺序和转义方式不比较（BS 的 `json_encode` 会转义 `/`）；
  - 图片按字节比较；204、304 和 HEAD 必须没有响应体；
  - BS 渲染 Laravel 的 HTML 错误页时（状态码 ≥ 400 且录制的 `Content-Type` 是 `text/html`），不比较响应体、`Content-Type` 和 `ETag`：错误页不是协议的一部分，客户端只看状态码。`Cache-Control`、`Allow` 和 ALI 头照样比较。
- 用例的 `body` 字段指定 JSON 里不能逐字比较的部分：
  - `yggdrasil-meta`：`implementationName`、`implementationVersion` 只要求是非空字符串；`signaturePublickey` 必须是 4096 位以上的 RSA 公钥，并且就是 NextSkin 签名用的那把；
  - `yggdrasil-profile`：`textures` 属性解码后比较，`timestamp` 只要求落在回放期间；签名用 NextSkin 的公钥验证；
  - `yggdrasil-error`：`errorMessage` 只要求是非空字符串（文案由语言包决定）。

## 照样复现的 BS 行为

下面这些看起来像 bug，但客户端、服务器或 CDN 会遇到，录制结果守着它们。不要"修"：

- 按名字查角色忽略大小写，也忽略末尾的空格（MySQL 的 PAD SPACE 比较），不忽略开头的空格。按 UUID 查同样忽略大小写和末尾空格，带连字符的 UUID 查不到（204）。
- CSL、USM、Legacy 的角色名不能含点号（Laravel 路由 `{player}.json` 的参数不匹配 `.`），返回 404，且不带公开缓存头。Yggdrasil 的路由参数解码后含 `/` 时同样 404。
- Yggdrasil 批量查询和单个查询返回的 `name` 是请求里的名字，不是角色名。
- TrimStrings 中间件对查询参数、以及 Content-Type 是 JSON 时请求体里的字符串做 PHP 的 `trim()`，ConvertEmptyStringsToNull 再把空串换成 null；路由参数不处理。
- 批量查询照 `array_unique($request->json()->all())`：对象取值、单个值当作一个元素；trim 之后按 PHP 转成字符串的值去重，所有元素（包括 null 和数字）都计入上限，只查字符串。
- 同名查询参数取最后一个（PHP 的规则），`unsigned[]=…` 是数组。`unsigned` 只有缺省、trim 后为空或恰好是 `true` 时不签名。
- 被封禁用户的角色：CSL、USM、Legacy 返回 403，Yggdrasil 照常返回。
- 条件请求照 Symfony 5.4.1：有 `If-None-Match` 就只看 ETag（各项和 ETag 都先去掉 `W/`，`*` 总是命中，CSL 的响应没有 ETag 也会被 `*` 命中），否则比较 `If-Modified-Since`。日期只认 IMF-fixdate 和 RFC 850。
- 公开缓存的端点（CSL、`/textures`）找不到时，404 也带 `Cache-Control: max-age=N, no-cache, public`。
- 方法不对时返回 405 和 `Allow: GET, HEAD`（或 `POST`）；OPTIONS 返回 200 和 `Allow: GET,HEAD`（没有空格）。
- HEAD：Laravel 在缓存中间件之前就清空了响应体，所以成功的 CSL 和材质响应在 HEAD 时没有公开缓存头和 ETag（`Cache-Control: private, must-revalidate`），也不处理条件请求。
- 站点地址按 `Host` 头算，`X-Forwarded-Proto` 逐字等于 `https` 或 `X-Forwarded-Ssl: on` 时用 https，`:80` 按连接本身的 http 去掉。
- Yggdrasil 的错误响应不带 `X-Authlib-Injector-API-Location`；按 UUID 查角色成功时，这个头和材质地址都用站点地址（`site_url`），scheme 跟随请求。

## 有意的差异

属于 ADR-0016"不复现"一表的哪一类，写在括号里。

在 `cases.ts` 里用 `deviation` 标出的用例照样录制 BS 的响应留档，回放时改为与 `compareWith` 指定的用例比较：

| 用例 | BS 的行为 | NextSkin 的行为 |
|---|---|---|
| `textures/usm-prefix` | usm-api 1.2.3 注册 `/usm/textures/{hash}` 时没写控制器的命名空间，返回 500（插件 bug） | 与 `/textures/{hash}` 相同 |

没有录制、NextSkin 有意不复现的行为：

- 错误页的内容；`Accept: application/json` 时不同的错误响应，404 不带 `no-cache`（错误页）。
- 错误页上的条件请求：BS 对 404 错误页也计算 ETag，`If-None-Match: *` 会让 404 变成 304（错误响应上的条件请求）。
- `Rene` 能查到 `René`、`Ｓteve` 能查到 `Steve`、UUID 里的 `é` 等于 `e`（排序规则的折叠）。
- `/Steve%2Ejson`、`/%63sl/Steve.json`、`/csl%2FSteve.json`、`/csl/Steve.json//`（编码过的路径字符）。
- `If-Modified-Since: @2000000000`、`2026-02-03T04:34:56Z` 等非 HTTP 日期（`strtotime` 的格式）。
- 批量查询请求体里的 `0`、`false` 在 MySQL 上能匹配任意角色名，嵌套数组、空对象让 BS 500；NextSkin 只计数、不查询（异常输入）。
- 非法的百分号编码（`Steve%.json`、`%00`）被 BS 前面的 nginx 拒绝为 400，NextSkin 返回 404（编码过的路径字符）。
- BS 的 `/textures/{hash}` 只看磁盘上有没有文件，NextSkin 只认 `texture_files` 里 `active` 的行（孤儿文件）。
- BS 在角色第一次被 Yggdrasil 按名字查询时才分配 UUID，之前按 UUID 查不到（ADR-0015）。录制前先查一遍，消除这个差异。
