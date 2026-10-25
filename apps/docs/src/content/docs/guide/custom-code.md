---
title: 自定义代码
description: 往页面里加统计、广告和站点验证的代码，改站点的样式，提供 ads.txt。
---

后台“设置 → 自定义代码”里有三项：页头代码、自定义 CSS 和 ads.txt。只有超级管理员能改，每次改动连同全文记进审计日志。

## 页头代码

贴统计、广告服务商或搜索引擎给的代码，放进每个页面的 `<head>`。保存时会检查，只收三种标签：

- `<script>`：外部脚本和内联代码都可以；
- `<meta>`：带 `name` 或 `property` 和 `content` 的，用来向搜索引擎验证站点；
- `<noscript>`：收下，但不输出。

别的标签（`<div>`、`<iframe>`、`<style>`、`<link>`……）、`onload` 这类事件属性、标签外面的文字都不收，同一个地址的 `async` 脚本也不能写两遍（页面上只会输出第一个），保存时会指出是第几行。Blessing Skin 的“自定义 JavaScript”填的是不带标签的代码，搬过来时要包上 `<script>` 和 `</script>`。

几件要知道的事：

- **权限和站点自己的代码一样**：这些代码看得到页面上的内容，包括登录页上输入的密码，也能以访客的身份操作。只贴信得过的服务商的代码。
- **管理员看不到**：管理员和超级管理员登录以后，任何页面都不加载页头代码。登录前就开着、已经加载了这些代码的其他标签页，会在登录后自动刷新一次。后台地址里的搜索词（邮箱、IP）不会发给统计服务商，管理员自己的浏览也不计入统计。核对代码有没有生效，用浏览器的无痕窗口打开站点。
- **保存后刷新页面才生效**。
- **有几种写法不执行**：页面带严格的内容安全策略（CSP），站点给贴进来的每个 `<script>` 带上 nonce，由它们再加载的脚本照常执行。以下写法会被浏览器拦下，控制台里有 `Content-Security-Policy` 的报错：
  - 用 `document.write` 插入脚本，例如老版本的 CNZZ 统计代码；
  - 内联的事件属性；
  - `eval`、`new Function`，例如 Google Tag Manager 的“自定义 JavaScript 变量”。

### 统计

各家给的代码原样贴进去。站点的页面之间是客户端跳转，不重新加载页面，统计服务要自己记下这种跳转：

- GA4（增强型衡量）、Umami、Plausible、Cloudflare Web Analytics 会自己记，不用另外处理。
- 百度统计默认只记第一次打开的页面。在它的代码后面加上这一段：

  ```html
  <script>
    window.addEventListener('nextskin:navigate', (event) => _hmt.push(['_trackPageview', event.detail.path]))
  </script>
  ```

每次客户端跳转完成，站点在 `window` 上派发 `nextskin:navigate` 事件，`event.detail.path` 是新页面的路径加查询串（不带 `#` 后面的部分）；第一次打开页面时不派发。别的服务需要手动记浏览时也用它。GA4 不要再接这个事件，否则一次跳转会记两次。

在 Cloudflare 里开了 Web Analytics 自动注入的，不用再贴它的代码，见[反向代理与 HTTPS](/guide/install/reverse-proxy/#cdn-和内容安全策略)。

### 广告

AdSense 的自动广告：把 AdSense 给的 `<script async src="https://pagead2.googlesyndication.com/…">` 贴进页头代码，再把 AdSense 给的 ads.txt 内容填进[ads.txt](#adstxt)一项。

- AdSense 的广告代码在这套 CSP 下实测能加载、没有报错；自动广告要真实的账号才能测，还没有实测过。浏览器控制台里出现 CSP 报错的话，请到 GitHub 上反馈。
- 页面里还没有放手动广告单元的位置。
- 不想让某些页面出现广告，在 AdSense 后台自动广告的“页面排除”里设置。

### 站点验证

搜索引擎让你在首页加一行 `<meta>` 的，贴进页头代码即可：

```html
<meta name="google-site-verification" content="…" />
<meta name="baidu-site-verification" content="…" />
```

站点已经输出的 `viewport`、`description`、`keywords` 和 `og:type`、`og:site_name`、`og:title`、`og:description` 不收，免得重复。站点描述和关键词在“设置 → 站点”里改。

## 自定义 CSS

改站点的样式。后台（`/admin` 下的页面）不套用，CSS 写坏了也能进后台改回来。改颜色优先用配色主题（后台的“主题”页）：在 CSS 里覆盖颜色不经过对比度检查，而且对每一套主题都生效。

跨版本保证不变的只有这几样：

- 颜色、字体、圆角这些设计 token 的 CSS 变量，例如 `--color-accent`、`--font-sans`；
- `<html>` 上的 `data-mode`（`light` 或 `dark`）和 `data-theme`（当前配色主题的 id）。

类名和页面结构每个版本都可能变，升级时不另行说明。选中它们的 CSS 升级后可能悄悄失效，升级以后看一眼。

例如把正文换成另一种字体：

```css
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC&display=swap');

:root {
  --font-sans: 'Noto Serif SC', serif;
}
```

CSS 里不能出现 `</style`。

## ads.txt

广告联盟要求放在站点根路径的文件。填了内容，站点就在 `/ads.txt` 提供它；空着时返回 404。维护模式下照常能访问，广告联盟的爬虫不会以为文件没了。

## 页面被弄坏了

贴进来的代码让页面打不开、后台也用不了时，在服务器上运行[命令行](/guide/commands/#disable-custom-code)：

```bash
node nextskin.mjs disable-custom-code
```

它清空页头代码和自定义 CSS，ads.txt 不动。原来的内容记在审计日志里（后台的“审计日志”，动作是“修改设置”，点“查看改动”），改好以后再贴回去。

## 从 Blessing Skin 迁移

导入不带上 Blessing Skin 的自定义 CSS、自定义 JavaScript 和 `meta_extras`，导入报告里会列出旧站填过的内容：

- 旧的 CSS 是写给 Blessing Skin 的页面结构的，在新页面上没有意义；
- 旧的 JavaScript 可能用到 jQuery、`document.write`，原样搬过来多半会报错。

要用的话，照上面的规则改好，贴进对应的设置项：自定义 JavaScript 包上 `<script>` 标签，和 `meta_extras` 一起贴进页头代码。
