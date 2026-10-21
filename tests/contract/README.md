# 协议契约测试

Minecraft 协议（CSL / USM / Legacy / Yggdrasil）以真实 BS v6 的行为为唯一判据（ADR-0001、不变量 1）。这里的用例从 BS v6 录制，回放时在 NextSkin 上发同样的请求，比较响应。

| 命令 | 用途 |
|---|---|
| `pnpm --filter @nextskin/contract-tests test` | 回放。不需要 Docker：直接调 Hono 的 `app.request()`，数据库用 SQLite。`pnpm check` 和 `pnpm test:contract` 都会跑 |
| `pnpm --filter @nextskin/contract-tests record` | 重新录制。先按 `bs-v6/README.md` 启动录制环境 |
| `pnpm e2e` | 也会经过 Next standalone 回放全部用例（`apps/web/e2e/contract.spec.ts`）：rewrite 和 Next 自己的处理都不能改变协议响应 |
| `pnpm --filter @nextskin/contract-tests import-replay` | 导入检查（ADR-0031）：把录制环境的固定数据用导入器导入一个新的 SQLite 库，再回放全部用例和场景。和录制一样需要 Docker，会重写 BS 里的固定数据。`stored: false` 的材质在真实导入时缺文件、被跳过，引用它的两个用例（`csl/ghost`、`ygg/profile-ghost`）列为已知差异，不比较。改了导入器或者重新录制之后手动运行 |
| `node tests/contract/scripts/make-textures.ts` | 重新生成材质文件和清单。只在增删材质时运行，之后必须重新录制 |

## 目录

| 路径 | 内容 |
|---|---|
| `src/world.ts` | 固定数据：用户、材质、角色、UUID 映射、站点设置。录制时写进 BS，回放时写进 NextSkin |
| `src/cases.ts` | 用例：只写请求和比对方式。一问一答的用例，和按顺序发好几个请求的场景（见下） |
| `recordings/bs-v6.json` | 录制结果，由脚本生成，不要手改 |
| `src/compare.ts` | 比对规则 |
| `src/replay.ts` | 发送用例、与录制结果比较；回放测试、e2e、录制脚本共用 |
| `src/seed.ts` | 按 `docs/schema.md` 的导入对照把固定数据写进 NextSkin |
| `scripts/bs-instance.ts` | 往录制环境写固定数据，录制和导入检查共用 |
| `scripts/seed-sqlite.ts` | 把固定数据写进一个新的数据目录，e2e 用它启动 Next |
| `fixtures/textures/` | 材质文件（提交进仓库：文件字节随 zlib 版本变化，重新生成会改变 hash） |
| `bs-v6/` | 录制环境 |

## 录制

`scripts/record.ts` 清空 BS 里除超级管理员以外的用户、角色、材质、衣柜和 UUID 映射，写入 `world.ts` 的数据（BS 的 datetime 按 Asia/Shanghai 写入，材质文件的修改时间设为固定值），清缓存，然后：

1. 对 `bsUuidRow: 'v3'` 的角色先查一次 Yggdrasil，让 yggdrasil-api 分配 UUID，再核对分配结果等于 `world.ts` 里按离线算法算出的值；
2. 逐个发送用例的请求，用 BS 自己的公钥验证签名，写入 `recordings/bs-v6.json`；
3. 逐个录制场景：每个场景开始前重新写入数据库里的固定数据、清空缓存。

改了 `world.ts` 或 `cases.ts` 就要重新录制；回放测试会检查用例和录制结果一一对应。录制结果的 diff 要逐条看：它就是协议行为的变化。

请求默认带 Java `HttpURLConnection` 的 Accept（CustomSkinLoader、authlib 都不改它）和 `Host: 127.0.0.1:38080`。

## 场景

authserver、进服和上传材质是有状态的：要先登录拿到令牌，后面的请求才能用它。`cases.ts` 里的场景是有序的若干步，每一步可以从前面的 JSON 响应里取 `accessToken`、`clientToken`（`capture`），填进后面的请求。

- 每个场景从固定数据开始：录制时重新写入 BS 的数据库、清空缓存（令牌、节流、进服记录都在缓存里）；回放时用一个新的核心实例。
- authenticate 和 signout 按 `username` 节流：同一个 `username` 1 秒内只能请求一次，不论成败。所以它们只出现在场景里，同一个场景里换着用邮箱和角色名登录；节流本身有两个专门的场景（authenticate、signout），回放它们时登录间隔放大到 60 秒（`contract.test.ts`）：间隔从请求开始时算，慢的机器上第一次登录就超过 1 秒。
- e2e 只回放一问一答的用例：Next standalone 只有一个实例，场景之间的令牌和节流会互相影响。经过 Next 的有状态流程由账号页的 e2e 覆盖（ADR-0030）。
- 两步验证、启动器登录列表、失败次数限速这些 BS 没有的行为，写在 `packages/api`、`packages/domain` 的测试里。

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
  - `yggdrasil-error`：`errorMessage` 只要求是非空字符串（文案由语言包决定）；
  - `yggdrasil-token`（只用于场景）：`accessToken` 只要求是非空字符串，并且与这个场景里之前出现过的都不同；请求里给了 `clientToken` 时逐字比较；没给时，录制结果里第一次出现的值只要求回放是非空字符串，之后同一个值在回放里也必须是同一个（refresh 沿用 clientToken）；其余字段（`availableProfiles`、`selectedProfile`、`user`）深比较。BS 在这一步返回错误时按 `yggdrasil-error` 比较。

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
- authserver 只收 JSON（Content-Type 含 `/json` 或 `+json`）：其他请求返回 **200** 和 `{"error":"Unsupported Media Type",…}`，这个响应带 ALI 头。
- authserver 请求体里的字符串照样 trim，包括密码；空串当作没给。`requestUser` 按 PHP 的真假判断：`"false"` 是真，`"0"` 是假。
- 用户不存在、密码错误都是 403；用户名或密码为空是 400。refresh 选择角色时，名字只要求有角色叫这个名字，按 `id` 找用户自己的角色；令牌已经绑定了角色时再选择，即使是同一个也是 400。
- 同一个 `username` 的 authenticate、signout 共用节流，邮箱和角色名各算各的。
- `hasJoined` 的 `username` 也被 trim，与角色名逐字比较（大小写不同返回 204）；查询不删除进服记录。

## 有意的差异

属于 ADR-0016"不复现"一表的哪一类，写在括号里。

在 `cases.ts` 里用 `deviation` 标出的用例照样录制 BS 的响应留档，回放时改为与 `compareWith` 指定的用例比较：

| 用例 | BS 的行为 | NextSkin 的行为 |
|---|---|---|
| `textures/usm-prefix` | usm-api 1.2.3 注册 `/usm/textures/{hash}` 时没写控制器的命名空间，返回 500（插件 bug） | 与 `/textures/{hash}` 相同 |
| `profile/upload-others` | 用自己的令牌给别人的角色上传材质：204，扣的是对方的积分（yggdrasil-api 的安全缺陷） | 403 |
| `profile/delete-others` | 用自己的令牌删除别人角色的材质：204（yggdrasil-api 的安全缺陷） | 403 |
| `auth/signout-player-name` | 用角色名 signout 返回 204，却什么也没吊销，之后旧令牌 `validate` 仍是 204（yggdrasil-api 的安全缺陷） | 吊销这个用户的全部令牌，之后 `validate` 是 403 |
| `session/join-forwarded-ip` | join 时采信请求自带的 `X-Forwarded-For`，`hasJoined` 带上伪造的 IP 返回角色资料（yggdrasil-api 的安全缺陷） | 只按受信代理解析客户端 IP，返回 204 |

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
- 节流的键：BS 不转小写，`Steve` 和 `steve` 各算各的；NextSkin 转小写（ADR-0030）。
- refresh 之后令牌列表按邮箱大小写分裂、复用自己上传过的材质不扣衣柜费（yggdrasil-api 的安全缺陷）。录制环境的邮箱都是小写，上传的文件 BS 按文件字节（还多了 multipart 结尾的换行）算 hash，碰不到这两条。
- 上传站内已有的图：BS 按文件字节判断，总是新建材质；NextSkin 按像素 hash 复用已有的材质（ADR-0030），模型不同时返回 400。场景里只上传模型相同的图。
- `{type}` 不是 `skin`、`cape`：BS 先扣分、建材质，再在改角色时 500；NextSkin 返回 400（异常输入）。
- refresh、validate 不带 `accessToken`：BS 500（PHP 的类型错误）；NextSkin 返回 403（异常输入）。
- 令牌的有效期、可刷新期：与时间有关，录不了，由 `packages/domain` 的测试守着。
