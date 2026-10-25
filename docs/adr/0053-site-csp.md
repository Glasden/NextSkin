# ADR-0053 站点的内容安全策略：页面带严格 CSP（按请求生成的 nonce 加 `'strict-dynamic'`），只约束脚本、插件对象、`<base>`、表单和被嵌入，不维护来源白名单；全站不许嵌进别的网站

- 状态：已采纳（"和以后的统计脚本"一节由 ADR-0063 落地）
- 日期：2026-10-22
- 补充 ADR-0011：落地它定下的 nonce 方案和 Base UI 的 `CSPProvider`；样式不受约束，与 S3 spike 里的 `style-src` 不同
- 补充 ADR-0037：授权页的 `frame-ancestors 'none'` 扩到全站
- 取代 ADR-0038 里"内容安全策略"一节：不按页面放行验证码服务商的域名
- 补充 ADR-0042：满足"先上 CSP"的前提，统计和广告脚本、自定义 CSS 可以另做

## 背景

页面没有全站的 CSP。现有的只有两处：`/device`、`/oauth/consent`、`/oauth/error` 带 `frame-ancestors 'none'` 和 `X-Frame-Options: DENY`（ADR-0037，`proxy.ts` 的 `NO_FRAME_PAGES`）；插件路由的响应固定一条 sandbox CSP（ADR-0033）。

防 XSS 现在全靠渲染方式：React 转义文本；管理员写的 Markdown 不渲染原始 HTML，链接和图片按协议过滤（ADR-0028）；材质描述按纯文本显示（ADR-0025）。CSP 是这之后的第二道防线，哪天某处漏了，注入的脚本也跑不起来。ADR-0011 和 S3 的结论不变：CSP 防的是通过数据注入的脚本，约束不了插件代码。

页面上会执行的内联脚本有三类：
- 根布局 `<head>` 里设亮暗模式的脚本（`lib/color-mode.ts`）。它要赶在第一次绘制之前运行，不能改成延迟加载的外部文件；
- Next 和 React 自己的：水合数据（`self.__next_f.push(…)`）、启动代码、流式渲染时替换 Suspense 边界的脚本，每个请求都不同；
- Base UI 的 `Tabs.Indicator` 带 `renderBeforeHydration` 时，在水合之前插一段内联脚本，把指示条摆到位（`packages/ui` 的 Tabs 用了它）。

外部脚本只有验证码：`lib/captcha.tsx` 在登录、注册、找回密码页用 `document.createElement('script')` 加载启用的那一家。ADR-0038 当时打算"只在这三页、只放行启用的那一家"的域名。

有几处收不紧：
- 管理员写的 Markdown（公告、页脚、内容政策、维护说明）允许任意 http(s) 图片（`markdownUrl`），页脚的公安备案图标就是外站的图；
- 服务端渲染的 HTML 里有 `style` 属性（`SkinFigure`、`PlayerHead` 的尺寸等）。nonce 管不到属性，只要约束 `style-src`，就得为它们打开 `'unsafe-inline'`；
- 上传页用 `blob:` 地址预览本地材质。

ADR-0042 把统计和广告脚本、自定义 CSS 推到 CSP 之后：先放开脚本、后加 CSP，会把站长已经填好的脚本弄坏。BS 的 `custom_js`、`meta_extras` 是原样插进页面的 HTML，ADR-0010、0032 定下的去向是核心里"受管控的统计/广告脚本"设置项。

站点由站长自己部署，很多放在 CDN（常见的是 Cloudflare）和面板的反向代理后面。站长不会去维护一份 CSP 白名单。

可用的条件：
- Next 16 支持的浏览器（Chrome、Edge、Firefox 111+，Safari 16.4+）都支持 CSP3 的 `'strict-dynamic'`。
- Next 从请求头的 `Content-Security-Policy` 里解析出 nonce，自动加到框架脚本、页面的脚本和它生成的内联脚本上，前提是页面动态渲染。本站所有页面本来就动态渲染（根布局 `force-dynamic`，ADR-0032）。

## 决定

### 策略

页面的响应带这一条。它不读设置，站长也改不了：

```
script-src 'nonce-{nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

- `script-src`：只认带本次 nonce 的脚本，以及由它们加载的脚本（`'strict-dynamic'`）。注入的 `<script>`、内联事件处理属性（`onerror=` 之类）、`javascript:` 链接都不执行。
  - 不写 `'self'` 和域名：有了 `'strict-dynamic'`，浏览器会忽略它们。
  - 不写给旧浏览器的退路（`'unsafe-inline' https:`）：支持的浏览器都认 `'strict-dynamic'`。
  - 不开 `'unsafe-eval'`、`'wasm-unsafe-eval'`：生产环境的代码不用 `eval`；浏览器里解 PNG 用的是 `DecompressionStream`，没有 WASM。
- `object-src 'none'`、`base-uri 'none'`：站内没有用 `<object>`、`<embed>`、`<base>`。这两项堵住绕过 `script-src` 的两条老路。
- `form-action 'self'`：原生提交的表单（搜索框、`/device`）都提交给自己。其余表单用 `fetch` 提交，第三方登录和 OAuth 同意页都是请求完成后再用 `location.assign` 跳转，不受这一项影响。它挡住注入的表单把输入的密码提交到别的站。
- `frame-ancestors 'none'`：全站都不许嵌进别的网站的 iframe，同时发 `X-Frame-Options: DENY`，理由见"被嵌入"。
- 不写 `default-src`：样式、图片、字体、请求、iframe 都不约束，理由见"只管脚本"。

开发模式（`next dev`）的 `script-src` 多一个 `'unsafe-eval'`：React 在开发模式里用 `eval` 还原服务端的错误堆栈（Next 文档）。e2e 跑的是发行目录，测的是生产环境的策略。

### nonce

- `proxy.ts` 给每个页面请求生成一个 nonce：16 字节随机数，base64 编码。
- nonce 写进响应头的 CSP，同时覆盖两个请求头：`Content-Security-Policy`（Next 从这里取 nonce，给自己的脚本加上）和 `x-nonce`（页面自己读）。客户端自带的这两个头一律覆盖，不能带进渲染。
- 换成维护页的响应（导入期间和手动维护，ADR-0031、0044），以及读不到设置时照常渲染的页面，也都带这条策略。它不依赖数据库。
- 以下几类响应不加页面的策略：
  - 进 Hono 的路径（`HONO_PATHS`）：它们不是页面；协议端点的响应头要和 BS 一致（不变量 1）；插件路由已经有自己的 sandbox CSP。
  - `/favicon.ico` 的跳转和 `public/` 里的静态文件。
- 根布局用 `headers()` 读出 `x-nonce`，用在两处：
  - 设亮暗模式的内联脚本带上它；
  - 传给 `packages/ui` 新导出的 CSP Provider。它包一层 Base UI 的 `CSPProvider`（同 `ToastProvider`，`apps/web` 不直接依赖 Base UI），Tabs 的水合前脚本和 Select 弹层插入的 `<style>` 都由它带上 nonce。
- JSX 里写的 `<script>` 必须带 `nonce`，由新的 lint 规则守着，原因写在报错里。

### 只管脚本

采用"严格 CSP"：nonce 加 `'strict-dynamic'`，不列来源。不用白名单式的策略（`default-src 'self'`，再逐项放行）。理由：

- CSP 防的是通过数据注入的脚本，单是 `script-src` 一项就挡住了它的主要形式。其余各项的白名单在这里挡不住多少东西：图片必须放行任意 http(s) 地址（Markdown）；有 `style` 属性，`style-src` 就离不开 `'unsafe-inline'`；而脚本一旦跑起来，跳转或加载图片照样能把数据带出去。
- 白名单要有人维护。每加一家验证码、一个统计服务、一个插件的外部资源，都要改策略；服务商用的子域名还会变（hCaptcha 的文档要求写 `*.hcaptcha.com`，不要写死子域名）。白名单写错了，坏的是功能。
- 验证码不需要单独放行：`captcha.tsx` 在带 nonce 的脚本里创建 `<script>`，`'strict-dynamic'` 信任这个脚本；由它再加载的脚本同样被信任，iframe 不受约束。Turnstile 和 reCAPTCHA 的文档都推荐 nonce 方案，写明支持 `'strict-dynamic'`。hCaptcha 的文档只给了白名单，没提 `'strict-dynamic'`，落地时实测。

### 被嵌入

`frame-ancestors 'none'` 从三个授权页扩到全站：

- 点击劫持不只危及授权页。后台的删除、改身份，用户中心的删除角色，都是一次点击。
- 嵌进别的网站本来就用不了：会话 Cookie 是 `SameSite=Lax`（Better Auth 的默认值），跨站 iframe 里的请求带不上它，页面在 iframe 里总是未登录的状态。
- 启动器和游戏服务器访问的是协议端点，不经过 iframe，不受影响。

### 和以后的统计脚本

这份 ADR 不做统计和广告脚本，也不做自定义 CSS（ADR-0042 推迟的那些），只定它们和 CSP 的关系，以后另写 ADR 时策略不用改：

- 这些脚本由核心渲染，带上 nonce。它们再加载的脚本由 `'strict-dynamic'` 放行；上报用的图片和请求不受约束，站长不用维护白名单。
- 有几种写法照样会被拦，到时在设置的说明里写明：
  - 用 `document.write` 插入脚本（老版本的 CNZZ 统计代码）：`'strict-dynamic'` 不信任这样插入的脚本；
  - 内联事件处理属性；
  - `eval`：例如 Google Tag Manager 的"自定义 JavaScript 变量"。
- 自定义 CSS 不受这条策略影响，因为样式不约束。

### CDN 和反向代理

改写 HTML 的 CDN 功能会和 nonce 冲突。以下按 Cloudflare 的文档：

- **JavaScript Detections**：开着 Bot Fight Mode 时它一直开着，关不掉。Cloudflare 会解析响应头里的 CSP，给注入的脚本加上同一个 nonce；策略要放在响应头里，写在 `<meta>` 里它不认。
- **Rocket Loader、邮箱地址混淆**（Scrape Shield）：它们会改写页面里的脚本，文档要求为它们打开 `'unsafe-inline'` 或放行域名，在这条策略下会被拦。改写 HTML 本来就会让 React 的水合对不上，部署文档写明关掉。
- **Web Analytics 的自动注入**：文档只给了域名白名单，没提 nonce，落地时实测。不行就在部署文档里写明改用以后的统计脚本设置。

## 后果

- 每个页面请求多生成一个 nonce，没有别的开销：页面本来就动态渲染，也不缓存。
- 页面里不能再随手写内联脚本或内联事件处理属性。前端依赖在页面上插入不带 nonce 的内联脚本时会被拦：落地前排查一遍现有依赖，以后加依赖时注意。
- 插件的声明式界面不受影响。以后的运行时组件（ADR-0011）沿用这个 nonce：import map 带上它，插件的模块由 `'strict-dynamic'` 放行。插件读得到 nonce，CSP 照旧约束不了插件代码。
- 要改的地方：
  - `apps/web/proxy.ts`：生成 nonce，写响应头和请求头；去掉 `NO_FRAME_PAGES`，全站都发 `X-Frame-Options`。
  - 根布局：内联脚本带 nonce，外面包上 CSP Provider；`lib/color-mode.ts` 注释里"以后上 CSP"一句改掉。
  - `packages/ui`：导出 CSP Provider。
  - `packages/eslint-plugin`：新规则，JSX 里的 `<script>` 必须带 `nonce`。
  - `docs/deploy/README.md`：新增 CDN 一节，写上面三条。
- 测试：
  - 单元测试：策略字符串的内容；开发模式多 `'unsafe-eval'`；nonce 长度正确，每次都不同。
  - e2e：
    - 自动 fixture：任何用例的页面上出现 CSP 违规（`securitypolicyviolation` 事件或控制台的 CSP 报错）就判失败；
    - 首页、手动维护时的维护页、`/device` 带这条策略，两次请求的 nonce 不同；协议端点、插件路由、`/textures/*` 不带；
    - 不带 nonce 的内联脚本不执行：用 `page.addScriptTag` 插一段改 `window` 的脚本，断言没有生效；
    - 已有的亮暗模式、带 Tabs 的页面、验证码的假挂件（由 `captcha.tsx` 创建的脚本）照常通过，也没有违规；
    - `connect.spec.ts` 里"别的页面不加"的断言改成全站都有 `frame-ancestors 'none'`。
  - 手动核对：三家验证码各用官方的测试密钥走一遍；在挂在 Cloudflare 后面、开着 Bot Fight Mode 的部署上看控制台，没有 CSP 报错。结果写进提交说明。
    - 落地补充：官方测试密钥过不了 ADR-0038 的主机名核对，三家验证码改用真实密钥核对，都没有 CSP 违规。Turnstile 的挂件在控制台报 `connect-src` 拦下 `data:`，来自它自己 iframe 的 CSP，和站点无关。在 Cloudflare for SaaS 的自定义主机名后面开着 Bot Fight Mode：Cloudflare 往页面末尾插的内联脚本带着响应头里的 nonce，它再加载的 `/cdn-cgi/challenge-platform/…/jsd/main.js` 由 `'strict-dynamic'` 放行，检测请求照常发出，没有违规。同一个主机名开着 Web Analytics 的自动注入：插进来的 `beacon.min.js` 也带着这次请求的 nonce，统计照常上报。Cloudflare 只给 `Accept` 里有 `text/html` 的请求注入，用 curl 核对时要带上这个头。
- `PROGRESS.md`："还没做"里的"站点的 CSP"挪进已做。采纳时，ADR-0011、0037、0038、0042 的状态行和 README 的索引行注明由本 ADR 补充或取代。

## 考虑过的其他方案

- **白名单式的策略**（Next 文档的示例：`default-src 'self'`，样式也用 nonce，图片、请求、iframe 逐项列）：理由见"只管脚本"。落到本站：Markdown 的外站图片、服务端渲染的 `style` 属性、各家验证码的子域名，要么放到失去意义，要么弄坏功能。
- **只在验证码页放行服务商的域名**（ADR-0038 原来的打算）：有了 `'strict-dynamic'`，浏览器不看 `script-src` 里的域名，没有必要；去掉 `'strict-dynamic'`，又回到白名单。
- **用 hash 代替 nonce**，或者用 Next 实验性的 SRI：亮暗模式的脚本是固定的，可以算 hash；但 Next 的水合数据是每个请求都不同的内联脚本，只能用 nonce。hash 能换来静态缓存，可本站页面本来就动态渲染，用不上。
- **先只发 `Content-Security-Policy-Report-Only`，观察一段再执行**：没有收集报告的地方，违规只出现在访客的控制台里，没人看得到。页面上的内联脚本只有背景里那三类，由 e2e 的违规检查兜底。
- **收集违规报告**（`report-to` 指向站点自己的接口）：需要一个不登录就能写入的接口，还要限流、存储和后台页面，对自己部署的站点用处不大。以后有需要再做。
- **后台开关 CSP，或者让站长追加策略**：核心的页面不依赖站长配置；第三方脚本以后由核心带 nonce 渲染，不需要追加。有开关的话，站长遇到问题多半会直接关掉它，可问题多半出在 CDN 改写了 HTML，该关的是 CDN 的那项功能。
- **用 `<meta http-equiv>` 写策略**：`frame-ancestors` 写在 `<meta>` 里无效，Cloudflare 的 JavaScript Detections 也只认响应头。
- **`upgrade-insecure-requests`**：只用 http 的内网站点会被它弄坏，HTTPS 交给反向代理（`docs/deploy/`）。
- **Trusted Types**：要求所有写 DOM 的地方（包括依赖）都改写法；有了这条策略，它多挡的那一点不值这个代价。
- **全站允许同源嵌入**（`frame-ancestors 'self'`）：站内没有嵌入自己页面的地方。
