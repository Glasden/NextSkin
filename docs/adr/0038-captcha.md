# ADR-0038 验证码：核心支持 Turnstile、hCaptcha 和 reCAPTCHA v2，一次启用一家；注册、密码登录、找回密码每次都要；核对不了一律拒绝；由入口调用，不进注册用例，不用 Better Auth 的验证码插件

- 状态：已采纳（"内容安全策略"一节已被 ADR-0053 取代：不按页面放行服务商的域名）
- 日期：2026-10-20
- 补充 ADR-0018：注册规则里的"验证码"一项落地；不由注册用例检查，由注册接口在调用用例之前核对
- 补充 ADR-0028：新分区"验证码"和四个设置项；设置页的"测试验证码"；概览页的配置检查多一项
- 补充 ADR-0031：导入 BS 的 reCAPTCHA 设置；BS 的图片验证码不迁移
- 补充 ADR-0033：落地"验证码做进核心"

## 背景

### BS 的做法

BS v6（`AuthController`、`Rules\Captcha`）：

- 三个设置：`recaptcha_sitekey`、`recaptcha_secretkey`、`recaptcha_invisible`。填了 secretkey，服务端就按 reCAPTCHA v2 核对：请求 `www.recaptcha.net` 的 siteverify，不带 `remoteip`，只看 `success`。没填就用 gregwar 生成的图片验证码，答案存在 session 里。
- 页面按 sitekey 选挂件：有 sitekey 显示 reCAPTCHA（reaptcha，打开 invisible 时在提交时执行），没有就显示图片验证码。所以两个 key 只填一个时，页面和服务端对不上，谁都过不了。
- 注册、找回密码每次都要。登录在同一 IP 一小时内密码错超过 3 次之后才要：计数在缓存里，登录成功清零；页面渲染时带 `tooManyFails`，失败的响应带 `login_fails`。

### 现状

- ADR-0018 的注册规则里有验证码，当时没做；ADR-0033 改成"核心用设置项选 Turnstile、hCaptcha 或 reCAPTCHA"，时间另定。现在没有任何验证码代码，挡滥用靠同 IP 注册上限、邮箱域名限制和 Better Auth 的限流。
- 注册走自己的 `POST /api/register`（Better Auth 设了 `disableSignUp`）。注册成功后，服务端经 `auth.api.signInEmail` 签发会话（`createSession`），不走 HTTP。密码登录 `/api/auth/sign-in/email` 和找回密码 `/api/auth/request-password-reset` 由 Better Auth 处理。
- 导入器不导入 `recaptcha_*`，也没把它们列进"不导入"的报告（`packages/importer/src/settings.ts`）：换站之后 reCAPTCHA 悄悄没了。
- 迁移指南（`packages/plugin-sdk/docs/migrating-from-bs.md`）把验证码列在"第一版迁移不了的部分"，写着"等核心验证码功能"。
- 站点没有全站 CSP，只有 `/device`、同意页的 `frame-ancestors 'none'` 和插件路由的 sandbox。全站 CSP 在 `PROGRESS.md` 的"还没做"里。

### Better Auth 的验证码插件

1.7.10 自带 `captcha` 插件：支持 Turnstile、reCAPTCHA（v2 和 v3）、hCaptcha 等；在 `onRequest` 里按路径拦截，默认拦 `/sign-up/email`、`/sign-in/email`、`/request-password-reset`；令牌放在 `x-captcha-response` 请求头；核对超时 10 秒，超时和出错都拒绝，返回 500。

它的配置在创建 Better Auth 实例时固定。`auth/service.ts` 按几项设置组成的缓存键重建实例，把验证码的设置加进去也能用；但注册不经过 Better Auth，还得另写一份核对。

## 决定

### 范围

- 支持三家：Cloudflare Turnstile、hCaptcha、Google reCAPTCHA v2（复选框和隐形两种）。一次只启用一家，默认不启用。
- 不做 reCAPTCHA v3 和 Enterprise：v3 只打分、不出题，分数低的真人没有办法补救，阈值要站长自己调；BS 用的是 v2，导入的密钥也是 v2 的。
- 不做图片验证码（ADR-0018 已经否决）。BS 没配 reCAPTCHA 时用的图片验证码不迁移，这样的站点导入后没有验证码，要站长自己配。
- 只用于网页表单。插件 API 不变：SDK 1.0 没有验证码 Provider（ADR-0033）；插件加在注册表单上的字段跟着注册页的验证码一起提交。

### 哪些入口要验证码

启用后，下面三个入口**每次**都要，不分别设开关：

| 入口 | 端点 |
|---|---|
| 注册 | `POST /api/register` |
| 密码登录 | `POST /api/auth/sign-in/email` |
| 找回密码 | `POST /api/auth/request-password-reset` |

登录不照 BS 等密码错几次之后才要，理由见"考虑过的其他方案"。

不要验证码的入口：

- 启动器登录（authserver）、OAuth 的令牌和设备码端点：协议里没有地方放（不变量 1）。照旧靠 `yggdrasil.loginIntervalMs`、两步验证和限流（ADR-0030）。
- 通行密钥登录、第三方登录和它的"完成注册"（ADR-0034）：没有可以猜的密码，第三方账号本身就是门槛。完成注册经过注册用例，但不经过注册接口。
- 两步验证的第二步：有自己的失败计数和锁定（ADR-0023、ADR-0030）。
- 提交新密码（`/reset-password`）：凭邮件里的令牌。
- 已登录的操作（重发验证邮件、改邮箱、改密码、批准设备、同意授权）和安装向导：要会话或安装码。

### 核对

- 核对在领域层（`packages/domain/src/captcha/`）：读设置、请求服务商的 siteverify。**由入口调用，注册用例不管验证码**：
  - 注册接口在调用注册用例之前核对，不通过就不调用；
  - Better Auth 的两个端点由一个只做这件事的 Better Auth 插件在 `onRequest` 里核对。`onRequest` 只拦 HTTP 请求，`createSession` 经 `auth.api` 调用，不受影响。
- 核对要等网络，必须在任何事务之外（SQLite 的写锁，AGENTS.md"已知的坑"）。
- 令牌放在请求头 `X-Captcha-Response`，三个入口一样，名字沿用 Better Auth。
- 每次核对都重新读设置，改了立即生效，不进 Better Auth 实例的缓存键。
- 请求带 `secret`、`response`，以及 `clientIp()` 解析出的 `remoteip`（解析不出就不带）；hCaptcha 另带 `sitekey`，要求令牌是给这个站点密钥签发的。超时 10 秒。
- 通过的条件：`success` 为真；设置了 `site.url` 时，响应里的 `hostname` 等于它的主机名。站点密钥允许多个域名、或者在 reCAPTCHA 后台关了域名校验时，这一条挡住在别的网站上解出来的令牌。
  - hCaptcha 放宽为"不是别的注册域名"：它报的是注册域名（实测在 `nextskin.glasden.top` 上解出来的报 `glasden.top`），流量大时还会报 `not-provided`，文档也说这个字段来自浏览器、只作统计。所以 `hostname` 是站点主机名本身、它的上级域名或 `not-provided` 都算对得上（比较前去掉末尾的根域点；不带点的顶级域名不算；站点地址是 IP 时不认上级）。
  - 代价：hCaptcha 上这一条只挡得住报成别的注册域名的令牌。同一个站点密钥也用在同一注册域名下的其他网站（兄弟子域名）时，那边解出来的令牌这边也认；报成 `not-provided` 的令牌不论在哪解出来都认。请求里的 `sitekey` 只保证令牌是给这个站点密钥签发的，分不出同一个密钥下的不同网站。站长应给本站单独建站点密钥，hCaptcha 后台能开域名白名单时打开。
  - 主机名对不上时记一条警告日志（服务商、站点的主机名和服务商报的主机名），后台的"测试验证码"把两个主机名都显示出来。
- 令牌只能核对一次、几分钟后过期，三家的服务端都管。核心不另记用过的令牌。

### 失败和服务商不可用

| code | 状态码 | 时机 |
|---|---|---|
| `captcha_required` | 400 | 启用了验证码，请求没带令牌 |
| `captcha_failed` | 403 | 服务商判定不通过，包括令牌过期、用过、主机名不符 |
| `captcha_unavailable` | 503 | 超时、连不上、5xx、响应格式不对；服务商说密钥不对（`invalid-input-secret`、hCaptcha 的 `sitekey-secret-mismatch` 等） |

- Better Auth 端点上的错误也用这三个 code（`APIError` 带 code），页面用同一套文案。
- 密钥不对是站长配错了，不是用户没过，所以算 `captcha_unavailable`，并记一条错误日志。其余的不可用记警告日志。日志只写服务商和错误类型，不写令牌和密钥（不变量 11）。
- **核对不了一律拒绝，不放行。** 放行的话，只要服务端连不上服务商，验证码就形同虚设，站长还以为开着。

代价是服务商故障、站点出网不通或密钥配错时，没有登录的人登录不了、注册不了。对策：

- reCAPTCHA 的脚本和核对都走 `www.recaptcha.net`：这是 Google 给访问不了 `www.google.com` 的地区准备的域名，BS 的服务端也用它。
- 后台的"测试验证码"在保存之后马上能试出密钥和网络的问题（见"后台"）。
- 通行密钥和第三方登录不要验证码，照样能用；已经登录的会话不受影响。
- 命令行 `pnpm disable-captcha` 能关掉验证码（见"命令行"）。

### 设置项

新分区 `captcha`（"验证码"），排在"注册"后面：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `captcha.provider` | `none`、`turnstile`、`hcaptcha`、`recaptcha` | `none` | |
| `captcha.siteKey` | 字符串 | 空 | 公开，传给页面 |
| `captcha.secretKey` | 字符串，机密项 | 空 | 只在服务端用，不回传浏览器（ADR-0028） |
| `captcha.recaptchaInvisible` | 布尔 | false | 只对 reCAPTCHA 有效；要和站点密钥的类型一致，v2 的复选框和隐形是两种密钥 |

- 选了服务商、两个密钥都填了，验证码才启用。表单是生成的，没有跨字段校验（ADR-0028）；选了服务商但密钥没填全时不启用，概览页的配置检查列出"验证码没有配置完整"（`configChecks` 的 `missing` 加 `captcha`）。
- 改动照旧写审计，机密项只记 `{ key, secret: true }`。

### 页面

- 登录、注册、找回密码三页的服务端组件读 `captcha.provider`、`captcha.siteKey`、`captcha.recaptchaInvisible`，作为属性交给表单（不变量 7）。没启用时不加载任何外站脚本，页面和现在一样。
- 挂件按需加载服务商的脚本、显式渲染，放在提交按钮上方。颜色跟随站点当前的亮暗主题，语言跟随页面语言，三家都支持这两个参数。
- 隐形 reCAPTCHA 在提交时执行，标志用 `badge: inline` 放在表单里，不浮在页面角上。
- 没拿到令牌（还在加载、要用户操作、已过期）就提交时，提示先完成验证码，不发请求。
- 每次提交之后，不论成败都重置挂件、取新令牌：令牌只能用一次，密码错了重试要用新的。
- 脚本加载失败（被拦截、网络不通）时，在挂件的位置显示错误、写明要能访问哪家服务商，给一个"重试"。
- 挂件的外框、加载中和加载失败的状态做成 `packages/ui` 的组件，配 story 和截图基线（不变量 10）；加载脚本、渲染挂件的部分在 `apps/web`。story 和截图不连外网。
- 不加新依赖：三家的显式渲染接口都只有渲染、重置、执行几个函数，在 `apps/web` 写一层统一的封装，不用 reaptcha、react-turnstile 这类库。

### 后台

- 设置页的验证码分区加"测试验证码"按钮，同"发送测试邮件"（ADR-0028）：用已保存的设置在对话框里渲染挂件，管理员完成之后，`POST /api/admin/settings/captcha/test` 按正式流程核对，显示通过、不通过（附服务商的错误码）或连不上。权限 `settings.manage`。
- 没启用时按钮不可用，提示先选服务商、填好两个密钥并保存。

### 命令行

`pnpm disable-captcha`：把 `captcha.provider` 设为 `none`。服务商故障、密钥配错、超级管理员登录不了时用。操作者是 system，照样写审计，IP 为空，同 `disable-2fa`。读和 `pnpm dev` 相同的环境变量。

### 导入器

- BS 的 `recaptcha_sitekey`、`recaptcha_secretkey` 都不为空时导入：`captcha.provider` 设为 `recaptcha`，两个密钥原样写入，`recaptcha_invisible` 写进 `captcha.recaptchaInvisible`。四个键加进 `IMPORTED_SETTING_KEYS`。
- 只填了一个时不导入，报告里列出：这样的配置在 BS 上本来就过不了（见"BS 的做法"）。
- `MIGRATION.md` 写明：reCAPTCHA 的站点密钥绑定域名，新站换了域名要在 Google 的控制台里加上；BS 的图片验证码不迁移。

### 内容安全策略

全站 CSP 以后另做，到时只在这三页、只放行启用的那一家。以各家文档为准，落地时核对：

- Turnstile：`https://challenges.cloudflare.com`（脚本、iframe）；
- hCaptcha：`https://hcaptcha.com`、`https://*.hcaptcha.com`（脚本、iframe、样式、连接）；
- reCAPTCHA：`https://www.recaptcha.net`、`https://www.gstatic.com`（脚本、iframe）。

### 落地

一次落地，不分切片，按 AGENTS.md 的顺序：领域层的核对和设置项 → 注册接口、Better Auth 插件和后台的测试接口 → ui 组件和三个页面、设置页 → 导入器和命令行。

## 后果

- 设置注册表多一个分区、四项。i18n：分区名，四项的标签和说明，三个错误码，挂件的提示和加载失败，测试对话框，配置检查，命令行的输出。
- Better Auth 的配置多一个插件，不进实例的缓存键。
- 注册接口的 OpenAPI 描述加上请求头 `X-Captcha-Response`，以及 400、403、503 的说明。
- 迁移指南的验证码一行从"迁移不了"挪进对照表，写明"核心内置，在后台设置里启用"；文档随 SDK 发布，附一个 patch changeset。`packages/importer/MIGRATION.md` 加 reCAPTCHA 一节。
- `PROGRESS.md`："还没做"的验证码一条挪进"认证和注册"。AGENTS.md 的命令表加 `pnpm disable-captcha`。
- 服务商故障或密钥配错时，没有登录的人登录、注册、找回密码都用不了，直到修好或用命令行关掉。这是有意的，见"失败和服务商不可用"。
- 测试：
  - 单元测试（换掉 `fetch`）：三家的通过、不通过、主机名不符、密钥不对、超时、5xx、响应格式不对；hCaptcha 带上 `sitekey`；没启用、密钥没填全时不发请求。
  - 接口测试：三个入口各自缺令牌 400、不通过 403、不可用 503，通过之后照常；注册核对不通过时不调用注册用例、没有写入；`createSession` 不受影响；启用之后通行密钥、第三方登录的完成注册、authserver 照常。
  - e2e 不连外网：浏览器里把服务商的脚本换成假的挂件。服务端的核对换不掉，假令牌必定通不过，所以只测不依赖核对结果的行为：没启用时三页不加载外站脚本；启用之后提交带上请求头、失败后提示并重置挂件、没完成就提交有提示。
  - 三家各用官方的测试密钥，在真实网络上手动走一遍（reCAPTCHA 走 `www.recaptcha.net`），结果写进提交说明。
- 采纳时：ADR-0018、0028、0031、0033 的状态行和 README 的索引行注明由本 ADR 补充。

## 考虑过的其他方案

- **登录照 BS，同一 IP 密码错超过 3 次之后才要**：要一个按 IP 的失败计数，多实例之间不共享（限流器默认在进程内，ADR-0002）；页面要事先知道显不显示挂件，多一种状态和一次往返；分散在许多 IP 上的撞库永远触发不了它，单个 IP 的暴力猜测已经有 Better Auth 的限流。代价是每次登录都要过验证码，Turnstile 和隐形 reCAPTCHA 多数时候不用操作。
- **三个入口分别设开关**：BS 也没有。任何一处不拦都是留给机器人的口子：不拦登录就挡不住撞库，不拦找回密码就能拿站点给任意邮箱发信。
- **用 Better Auth 的验证码插件**：注册不经过 Better Auth，要另写一份核对，两份的出错处理和错误码对不上（插件出错返回 500，错误码是它自己的）；配置固定在实例上，改设置要重建实例。
- **核对不了时放行**：见"失败和服务商不可用"。
- **验证码作为注册用例的输入**：第三方登录的完成注册也经过注册用例，就得给它开"跳过验证码"的口子；核对要等网络，也不该放进用例的事务。
- **令牌放在请求体里**：Better Auth 的端点按自己的 schema 解析请求体，插件在 `onRequest` 里读要先复制一份请求；放请求头，三个入口写法一样。
- **支持 reCAPTCHA v3**：见"范围"。
- **用现成的 React 封装库**：三家各一个依赖，主题、语言、重置的写法各不一样；接口很小，自己封装一层更统一。
- **同时启用多家、按地区切换**：没有需求，配置和测试都翻倍。
- **reCAPTCHA 走 `www.google.com`**：国内访问不了；`www.recaptcha.net` 各地都能用，BS 的服务端也用它。
- **核心记下用过的令牌**：三家的服务端都只认一次，多一张表没有用处。
