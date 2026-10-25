# ADR-0063 自定义代码：站长贴的统计、广告和站点验证代码经核心检查后带 nonce 放进 `<head>`，有管理权限的用户登录后不加载；客户端跳转派发 `nextskin:navigate`；自定义 CSS 不进后台；`/ads.txt`；CSP 不变

- 状态：已采纳
- 日期：2026-10-25
- 补充 ADR-0010、0032：BS 的 `custom_js`、`meta_extras` 和插件 google-adsense、gtag-js 的去向，落地为"页头代码"
- 补充 ADR-0028：新分区"自定义代码"；核心专用的代码控件；页头代码不合法时报出具体原因
- 补充 ADR-0042：做它推迟的统计和广告脚本、自定义 CSS
- 补充 ADR-0053：落地"和以后的统计脚本"一节，记下 AdSense 的实测；策略不变
- 补充 ADR-0039：命令行多一条 `disable-custom-code`

## 背景

BS 有四处可以往页面里加东西：`custom_css`（CSS）、`custom_js`（JavaScript 代码，BS 包进 `<script>` 插在每一页）、`meta_extras`（原样插进 `<head>` 的 HTML），以及插件 google-adsense、gtag-js。站长用它们做四件事：统计（百度统计、GA、51.la、Umami……）、广告（多是 AdSense 的自动广告）、向搜索引擎验证站点（`<meta>`）、改外观。

已经定下的：
- ADR-0010 把它们改成核心里受管控的设置项；插件不提供统计和广告。
- ADR-0053 定了它们和 CSP 的关系：脚本由核心渲染、带上 nonce，再加载的脚本由 `'strict-dynamic'` 放行；`document.write` 插入的脚本、内联事件属性、`eval` 照样被拦；CSS 不受影响。
- 导入器不导入这四项，在报告里列出旧站改过的（ADR-0031、`MIGRATION.md`）。

几处限制：
- 站点只有一个根布局（`apps/web/app/layout.tsx`），页面之间是客户端跳转，根布局不重新渲染。一段脚本在哪一页加载，就一直跑到整页刷新。按页面决定渲不渲染，挡不住从别的页面跳过来时已经在跑的脚本：从首页点"登录"就是客户端跳转。
- 客户端跳转时浏览器不重新加载页面。GA4（增强型衡量）、Umami、Plausible、Cloudflare Web Analytics 监听 history，自己记浏览；百度统计默认只记第一次打开的页面，之后要调 `_hmt.push(['_trackPageview', 路径])`。
- 后台的地址带搜索词：用户搜索的 `?q=` 里是邮箱、IP。统计脚本会把地址发给服务商，GA 的条款不许发送个人信息。
- 脚本跑在站点的源上，用的是当前访客的会话：看得到页面上的输入，能以访客的身份调接口。访客是管理员时，就是后台的接口。
- 设置表单（ADR-0028）没有写代码的控件；校验不过时，每项只显示"填写的内容格式不对"。

AdSense 的帮助页说它只支持严格 CSP，给出的 `script-src` 里带 `'unsafe-eval'`。`'strict-dynamic'` 让浏览器忽略来源列表和 `'unsafe-inline'`，但不忽略 `'unsafe-eval'`；本站正式环境的策略里没有这一项。实测的结果见"AdSense 和 CSP"。

## 决定

### 范围

新分区 `custom`（"自定义代码"，排在"高级"前面），三个设置项，只有超级管理员能改（`settings.manage`）：

| 键 | 内容 | 上限 |
|---|---|---|
| `custom.head` | 页头代码：统计、广告和站点验证 | 20 000 字符 |
| `custom.css` | 自定义 CSS | 50 000 字符 |
| `custom.adsTxt` | `/ads.txt` 的内容 | 50 000 字符 |

另有客户端跳转的事件 `nextskin:navigate`，和命令行的 `disable-custom-code`。

不做：
- 手动广告位（页面里放 `<ins class="adsbygoogle">`）：要在页面上留位置，动 DESIGN.md 的布局。第一版只有自动广告。
- 页尾代码、按页面开关：页尾的代码多是要占位置的挂件（统计图标、在线客服），以后有需要再做。
- 导入 BS 的这几项：见"导入"。
- Cookie 同意横幅：站长需要的话，同意管理平台（CMP）的脚本也贴在页头代码里。

### 页头代码

**格式**：贴服务商给的 HTML 原文。保存时用 parse5 解析（纯 JS，按 HTML 标准解析，带行号，ADR-0008），顶层只收三种标签：

- `<script>`：属性只收 `src`、`async`、`defer`、`type`、`crossorigin`、`referrerpolicy`、`integrity`、`charset`、`id` 和 `data-*`；`nonce` 忽略，由核心加上。
  - `src` 只能是 `https:`、`http:` 或 `//` 开头的地址。带 `src` 的标签里不能再写代码：浏览器会忽略它，多半是贴错了。
  - `type` 只收不写、`text/javascript`、`module`、`application/json`、`application/ld+json`。`importmap` 不收：一页只能有一个 import map，要留给插件的运行时组件（ADR-0011）。
- `<meta>`：只收 `name` 或 `property` 加上 `content`，用来向搜索引擎验证站点（`google-site-verification`、`baidu-site-verification`、`msvalidate.01`……）。
  - `http-equiv`、`charset` 不收：前者能让页面刷新跳转、追加 CSP。
  - 核心已经输出的 `viewport`、`description`、`keywords`、`og:type`、`og:site_name`、`og:title`、`og:description` 不收，免得重复。
- `<noscript>`：收下，但不渲染。服务商的代码里常带一个给不执行脚本的浏览器用的统计像素，站长删不删结果一样。
- 注释和空白忽略。其余的都不收：别的标签（`<div>`、`<iframe>`、`<style>`、`<link>`……）、`on*` 事件属性、标签外的文字。

不合法时报 `custom_head_invalid`，参数是原因、标签名、属性名和行号，表单把它显示在这一项下面，例如"第 3 行：`<script>` 不能带 `onload` 属性，事件属性不会执行"。标签外有文字时提示"直接写的 JavaScript 要放进 `<script>` 标签"：BS 的 `custom_js` 就是不带标签的。同一次保存里还有别的项不合法时，先只报这一项。

ADR-0053 列出的那几种写法（`document.write` 插入的脚本、`eval`，例如 GTM 的"自定义 JavaScript 变量"）不在保存时检查：写在字符串里、条件分支里的看不出来，猜错了会挡住能用的代码。它们写进这一项的说明和文档。

**渲染**：
- 存的是原文，后台显示的也是原文。渲染时再解析，按原文缓存结果。
- `<meta>` 和 `<script>` 按原来的顺序放进根布局的 `<head>`，排在亮暗模式的脚本和主题的样式后面。每个 `<script>` 带本次请求的 nonce，内联的代码原样输出。
  - 落地补充：带 `async` 的外部脚本，React 当成资源处理，挪到 `<head>` 的前面，并且按 `src` 去重。async 脚本本来就不保证执行顺序，挪了没有影响。但同一个 `src` 的 async 脚本写两遍时，第二个连同它的 `data-*` 会被丢掉，所以保存时报 `script_duplicate`。不带 `async` 的不去重。
- CSP 不变：它们再加载的脚本由 `'strict-dynamic'` 放行，请求、图片、iframe 本来就不约束。
- 改了以后刷新页面才生效：客户端跳转不重新渲染根布局，React 在客户端插入的内联脚本也不执行。

**哪些页面加载**：全站的页面都加载，除了：
- **有管理权限的用户（管理员、超级管理员，`hasAdminAccess`）登录以后的所有页面**。理由：
  - 按页面排除做不到（见背景）；按访客的身份可以，身份在整页加载时就确定了。
  - 后台的地址和里面的搜索词不会发给统计服务商；管理员在前台时，第三方脚本也拿不到能调后台接口的会话。
  - 管理员自己的浏览不进统计，也看不到广告。站长核对统计代码时用无痕窗口。
  - 为此，登录成功（`lib/navigation.ts` 的 `goToNext`）和退出登录都改成整页跳转，不再用 `router.replace` 加 `refresh`：访客登录成管理员以后，之前加载的脚本不能接着跑；管理员退出以后，根布局在客户端重新渲染出的脚本不一定执行，统计只装上一半。
  - 落地补充：整页跳转只管得了登录的那个标签页。Cookie 是整个浏览器共用的，跑着页头代码的旧标签页在别处登录以后，带着的就是管理员的会话。所以根布局在设了页头代码时加一个守卫（`app/head-code-guard.tsx`），遇到下面几种情况就整页重新加载：
    - 管理员的页面打开时，经 `BroadcastChannel` 广播一声，运行过页头代码的标签页收到就重新加载。不管经哪种方式登录，登录以后打开的总是管理员的页面。
    - 同一个文档里，根布局重新渲染时用户已经有管理权限（在线提升身份以后 `router.refresh()`）。
    - 同一个文档里，客户端跳进了 `/admin`。
  - 剩下的缺口：在线被提升身份的用户，旧标签页不刷新、也不进后台时，脚本接着跑；客户端跳进后台的那一下，监听 History API 的统计（例如 GA4 的增强型衡量）可能抢在重新加载之前记下这个地址。
- 导入期间（ADR-0031）：根布局本来就不查会话，也不读这一项。

登录页、注册页照样加载，因为挡不住已经在跑的脚本：页面上输入的密码，脚本看得到。这一项的说明写明：贴进来的代码和站点自己的代码权限一样，只贴信得过的服务商的。

### 客户端跳转的事件

- 客户端跳转完成后（路径或查询串变了，新页面已经渲染），在 `window` 上派发 `nextskin:navigate`（`CustomEvent`），`detail.path` 是路径加查询串，不带 `#`。第一次打开和 `router.refresh()` 不派发。
- 只在渲染了页头代码的页面上派发。
- 这是给站长的约定，写进文档。改名或改 `detail` 的结构要和协议一样小心：站长贴的代码不会跟着升级。
- 文档给出百度统计的写法：

  ```html
  <script>
    window.addEventListener('nextskin:navigate', (event) => _hmt.push(['_trackPageview', event.detail.path]))
  </script>
  ```

  GA4 的增强型衡量默认就记 history 的变化，不要再接这个事件，否则一次跳转记两次。

### 自定义 CSS

- 由根布局里的一个客户端组件输出成 `<style>`，放在 `<body>` 里，排在主题的样式后面。不放进 CSS 的 layer：Tailwind 的工具类都在 layer 里，layer 外的样式总是优先，选择器写得再简单也压得过。
- **后台（`/admin` 下的页面）不套用**：组件按 `usePathname()` 判断，客户端跳进后台时 React 卸下这个 `<style>`。样式和脚本不同，卸下就失效。写坏了的 CSS（`body { display: none }`）不会连改回来的地方也挡住。对管理员照常套用：前台的效果要看得到。
- 保存时拒绝含 `</style`（不分大小写）的内容：它会提前结束 `<style>`，后面的内容成了页面上的 HTML。别的不查：样式不受 CSP 约束（ADR-0053），用 `@import` 引外站字体照常可以。
- **只承诺这几样稳定**：
  - `theme.css` 里 token 的 CSS 变量（`--color-*`、字体、圆角……），改名算破坏性变化，写进发布说明；
  - `<html>` 上的 `data-mode`（`light`、`dark`）和 `data-theme`（主题 id，ADR-0057）。

  别的（类名、DOM 结构、`data-plugin-slot`）随时会变，升级时不另行说明。Tailwind 的类名每个版本都可能变。
- 改颜色优先用配色主题（ADR-0057）：在 CSS 里覆盖 token 不经过对比度检查，而且对所有主题都生效。

### ads.txt

- `GET /ads.txt`：`custom.adsTxt` 有内容时返回 200、`text/plain; charset=utf-8`、`Cache-Control: public, max-age=300`；没有内容时 404。AdSense 在根路径下找这个文件，找不到时后台提示收益可能受影响；别的广告联盟也认它。
- 由 Hono 处理，加进 `proxy.ts` 的 `HONO_PATHS` 和 `next.config.ts` 的 rewrite（两处必须一致）。手动维护（ADR-0044）时归为 `open`：爬虫没有会话，换成维护页的话，AdSense 会以为文件没了。

### 设置表单

- 新的控件 `code`，带 `language`（`html`、`css`、`text`），按 `contentMediaType` 是 `text/html`、`text/css`、`text/plain` 生成。和站点图片一样只认核心的设置项（ADR-0042）：插件的设置带同样的媒体类型照旧是单行文本，插件 API 不变。
- 控件是等宽字的 Textarea：不检查拼写，右下角显示字数。`packages/ui` 的 Textarea 加 `code` 属性，配上 story 和截图基线，DESIGN.md 的组件清单补上。
  - 落地补充：长行照样折行。不折的话，横向滚动条压在右下角的字数上。
- 审计（ADR-0027）照普通设置项记下改前改后的全文，不像 Markdown 那样只记长度：要查得出是谁、什么时候加了哪段脚本，`disable-custom-code` 清掉的内容也能从审计里找回来。三项都不是机密，页头代码和 CSS 本来就发给每个访客。审计页上多行的值折叠显示。

### 命令行

`nextskin disable-custom-code`：清空 `custom.head` 和 `custom.css`，操作者是 system，照样写审计（同 `disable-captcha`）。脚本或 CSS 把页面弄坏了、后台也用不了时用；`custom.adsTxt` 不动。

### 导入

仍然不导入 BS 的 `custom_css`、`custom_js`、`meta_extras`，报告照旧列出：
- CSS 选的是 BS 的页面结构，在新页面上没有意义；
- JS 是给 BS 的页面写的，可能用到 jQuery、`document.write`，原样搬过来多半在新站上报错，站长还不知道它在跑；
- `meta_extras` 是任意 HTML，混着别的东西时整段过不了检查。

`MIGRATION.md` 写明新设置在哪，贴之前按本 ADR 的规则改。

### AdSense 和 CSP

2026-10-25 实测：用正式环境的策略（不含 `'unsafe-eval'`）和一个假的发布商 ID，在无头 Chromium 里加载 AdSense 的手动广告单元。
- 加载器 `adsbygoogle.js`、主体脚本 `show_ads_impl`、流量质量检测的脚本都由 `'strict-dynamic'` 放行；广告请求的 iframe 和 reCAPTCHA 的 iframe 正常创建；没有一次 `securitypolicyviolation`。唯一的报错是广告请求对假 ID 返回 400。
- 加载器和主体脚本（约 500 KB）里没有 `eval(`、`new Function`、`document.write`。广告素材在 doubleclick 的跨源 iframe 里渲染，受那个 iframe 自己的 CSP 约束，本站的策略也不限制 iframe。

所以策略不加 `'unsafe-eval'`。没有测到的：自动广告（要真实账号才会加载 `show_ads_impl_with_ama`）、真实投放、锚定和插页广告、自动广告往页面里插的节点和 React 的水合。文档写成"支持贴代码，自动广告未经实测"，请站长遇到控制台里的 CSP 报错时反馈。

预案：以后确认 AdSense 要用 `eval`，就只在页头代码不为空时给 `script-src` 加 `'unsafe-eval'`，写成本 ADR 的落地补充；仍然不让站长追加策略，ADR-0053 否决的理由不变。`'unsafe-eval'` 放行不了注入的脚本，只让已经在跑的脚本能用 `eval`。

## 后果

- 每个页面多读两个设置项；页头代码的解析按原文缓存。
- 登录和退出改成整页跳转，所有用户在这两处都多一次完整加载。
- `nextskin:navigate` 和 CSS 的几个稳定钩子成了对站长的约定。
- 页头代码的说明和文档要写清楚：它的权限和站点自己的代码一样；哪些写法会被拦；管理员登录后看不到它。
- 要改的地方：
  - `packages/domain`：设置注册表的分区和三个设置项；页头代码的解析；`clearCustomCodeAsSystem`；`settingControl` 加 `code`；错误码 `custom_head_invalid`。
  - `packages/api`：`GET /ads.txt`；维护期间的分类；新错误码的状态和字段（`statuses`、`fieldNames`）。
    - 落地补充：保存设置的请求体上限从 192 KiB 提到 1 MiB。长文本加起来能写 164 000 个字，按每字最多 4 字节算，一次全填满约 640 KiB。
  - `apps/web`：根布局渲染页头代码、跳转事件和自定义 CSS 的组件；`proxy.ts` 的 `HONO_PATHS` 和 `next.config.ts` 的 rewrite；`goToNext` 和退出登录改成整页跳转；设置表单的代码控件；审计页的多行值。
  - `packages/ui`：Textarea 的 `code` 属性、story、截图基线；DESIGN.md 的组件清单。
  - `packages/db`（落地补充）：迁移把 `audit_logs.details` 在 MySQL 上从 `text` 改成 `longtext`。`text` 最多 65 535 字节，放不下两份五万字的全文，严格模式下整次保存失败。
  - `packages/i18n`：分区名，三个设置项的标签和说明，`custom_head_invalid` 的各种原因（`zh-CN`、`en`）。
  - `packages/launcher`：`disable-custom-code` 和帮助；`apps/docs` 的命令行页；AGENTS.md 的命令表。
  - `apps/docs`：新增"自定义代码"一页：几家常见服务的贴法（百度统计连同跳转事件、GA4、Umami、51.la、Cloudflare Web Analytics、AdSense 自动广告和 ads.txt、搜索引擎验证），会被拦的写法，CSS 的稳定钩子，管理员看不到，弄坏了怎么恢复。
  - `packages/importer/MIGRATION.md`。
- 测试：
  - 单元测试：
    - 页头代码的解析：几家服务商的原样代码能通过（GA4、百度统计、Umami、Plausible、51.la、AdSense、GTM 的 head 部分和 noscript、几种验证 meta）；不收的各种情况报对原因和行号；
    - CSS 含 `</style` 时被拒；
    - `code` 控件只认核心的设置项。
  - e2e（ADR-0053 的 CSP 违规检查照常生效）：
    - 页头代码里的内联脚本执行，它创建的 `<script>`（由测试起的本地服务器提供）也执行；`<meta>` 出现在 `<head>`；脚本往 `<head>` 和 `<body>` 里插节点，水合不报错；
    - 客户端跳转后派发 `nextskin:navigate`，`detail.path` 正确；第一次打开不派发；
    - 管理员登录后的页面没有页头代码；在同一个标签页里，访客登录成管理员以后，之前的脚本不再运行；同一个浏览器里跑着页头代码的另一个标签页自己重新加载；
    - 自定义 CSS 在首页生效、在后台不生效，从首页客户端跳进后台以后失效；
    - `/ads.txt` 有内容时 200、没有时 404，手动维护期间照常；
    - 页头代码不合法时，表单在这一项下面显示原因；
    - `disable-custom-code` 清空两项，审计记录的操作者是 system。
  - 截图回归：Textarea 的 `code`。
- 采纳时，`PROGRESS.md` 的"统计和广告脚本、自定义 CSS"一条指向本 ADR，落地后删掉；ADR-0042、0053 的状态行和 README 的索引行注明由本 ADR 补充。

## 考虑过的其他方案

- **按服务商做预设**（填 GA 的衡量 ID、百度统计的站点 ID……）：最受控，还能替百度统计接好跳转。但国内的统计服务很多（百度、51.la、友盟、腾讯……），做不全，新的服务要等核心发版。
- **把 HTML 原样插进页面**（BS 的做法）：内联脚本不带 nonce 不执行，要在渲染时找出脚本补上 nonce，还是得解析；不加限制的话，`<meta http-equiv>`、`<base>`、表单都能塞进来。
- **按页面排除**（登录页、后台不加载）：只有一个根布局，客户端跳转时已经在跑的脚本挡不住，还会让站长以为登录页是干净的。
- **后台用单独的根布局**（Next 在不同的根布局之间跳转时整页加载）：能按页面把后台干净地隔开。但没有共同的根布局时，404 页要用实验性的 `global-not-found.js`；而且隔开的只是后台的页面，管理员在前台时，脚本照样拿得到管理员的会话。
- **进登录页一律整页跳转**，登录、注册页不加载：进登录页的链接和服务端的 `redirect()` 有二十来处，漏一处就失效；换来的只是这两页不统计，脚本照样能在别的页面以访客的身份调接口。
- **为 AdSense 预先加 `'unsafe-eval'`**：实测的那部分用不上；没有证据就放宽策略，所有站点都要付出代价。
- **自定义 CSS 写成外部文件**（`/custom.css?v=<hash>`）：能缓存，不用防 `</style`；但多一个请求、多一条路由。几十 KB 以内，内联更简单，主题的 CSS 也是内联的。
- **自定义 CSS 在后台也套用**：后台的外观由 DESIGN.md 定；写坏了的 CSS 会连改回来的地方也挡住。
- **审计里页头代码只记长度**（同 Markdown）：查不出是谁加了哪段脚本。
- **保存时检查 `document.write`、`eval`**：写在字符串、条件分支里的看不出来，误报会挡住能用的代码。
