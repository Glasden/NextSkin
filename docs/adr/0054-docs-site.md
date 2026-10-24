# ADR-0054 文档站：Astro + Starlight 写在 `apps/docs`，正式版发布后部署到 Cloudflare Workers 静态资源，经 Worker 路由和自己维护的优选记录加速国内访问

- 状态：已采纳（提交进仓库的插槽截图由 ADR-0060 补充；读 R2 的 Worker `nextskin-dl` 和 `dl` 记录由 ADR-0061 补充）
- 日期：2026-10-22
- 补充 ADR-0040：落地"面向用户的文档站另建"

## 背景

面向服主、玩家和插件作者的文档散在几处：`docs/deploy`（写给服主和替服主操作的 agent）、`packages/plugin-sdk/docs`、`packages/importer/MIGRATION.md`，没有网站。

社区贡献者 NayaCcR 做了一个文档站：Astro + Starlight，MIT 许可，单独一个仓库，部署在作者本人的 Cloudflare 账号里。插件 API 参考在构建时从本仓库 main 的源码包下载生成。

域名 nextskin.org 的 NS 在 Cloudflare，免费计划。

读者主要在国内。站点没有 ICP 备案，用不了 Cloudflare 的中国网络；Cloudflare 默认分配的 IP 在国内延迟高，有的地区打不开。社区的通行做法是"优选"：把域名解析到国内访问较快的 Cloudflare 节点 IP。前提是自己控制解析和路由：开着代理（小黄云）时，解析出什么 IP 由 Cloudflare 决定；关掉代理，Cloudflare 就不再替这个主机名把请求导到对应的服务。Worker 路由按主机名匹配，不看 DNS 记录开没开代理，所以记录可以不开代理、自己填 IP。

Cloudflare 现在推荐新项目用 Workers 静态资源，Pages 继续可用，但不再加新功能。Pages 不支持 Worker 路由，自定义域要 CNAME 到 `*.pages.dev`，由 Cloudflare 代理。

## 决定

### 代码在本仓库

- 文档站并进 `apps/docs`（包名 `@nextskin/docs`），从 NayaCcR 仓库的提交 `c2f0f02` 开始，导入提交的作者是 NayaCcR。本仓库只允许 rebase 和 squash 合并，保留原历史的 subtree 合并提交进不了 main。
- 插件 API 参考在构建时从同一次检出的 `packages/plugin-sdk/docs` 生成，不联网下载；生成的文件不进仓库。
- 页脚显示 NextSkin 的版本（取启动器的 `package.json`）和插件 SDK 的版本，链接到本仓库对应的提交。
- 外观用 Starlight 自带的组件。配色和标志从 `packages/ui` 转录，像素字体直接引用 `packages/ui/src/fonts` 里的文件。不用 `packages/ui` 的 React 组件：文档站是纯静态页面，用不着。

### 正式版发布后部署

- 维护者把草稿 Release 发布之后（`release: published`，只认 `v*` 正式版，跳过预发布），工作流在这个标签上构建并部署。只有这个版本是已发布的正式版里最新的才部署：给旧的次版本发修订版，不会把文档退回旧版本（判断方法同 `release-image-tags.yml`）。
- 网站上的文档对应最新的正式版。main 上已经改了、还没发布的功能不会出现在网站上。只改文档的修正要等下一次发版，修订版也算。手动触发（`workflow_dispatch`，选一个标签）用来在部署失败后重跑。
- 部署凭据放在 GitHub 的 `docs` environment，只允许 `v*` 标签使用。Cloudflare 令牌只有这个账号的 Workers 脚本编辑权限和 nextskin.org 的 Workers 路由编辑权限，不能改 DNS。
- PR 和推送上，改了文档站相关的文件时只构建、不部署。CI 的主工作流忽略 `*.md`，文档内容的改动由这一步兜住。

### Cloudflare 上的形态

- Worker `nextskin-docs` 只有静态资源，没有脚本：静态资源的请求免费，不计调用次数。关掉 `workers.dev` 地址和预览地址。
- 绑路由 `docs.nextskin.org/*`，不用自定义域（custom domain）：自定义域由 Cloudflare 建一条开着代理的 DNS 记录，改不了指向，也就没法优选。
- DNS 记录都不开代理：
  - `edge.nextskin.org`：几条 A 记录，填 Cloudflare 官方 IP 段（<https://www.cloudflare.com/ips/>）里、国内访问快的地址；
  - `docs.nextskin.org`：CNAME 到 `edge.nextskin.org`。

  请求到了这些 IP，Cloudflare 边缘按主机名匹配 nextskin.org 的 Worker 路由，证书用区域的 Universal SSL。
- IP 只从官方段里选。官方段是 anycast，海外访客照样连到就近的节点；某个 IP 的线路变差，最坏是变慢，不会打不开，也不会被导到别处。挑法：在国内网络上测延迟（CloudflareST 之类），或者参考公共优选域名当前的解析结果，去掉不在官方段里的。IP 不写进仓库，变慢了就在 DNS 里换 `edge` 的记录。
- 回退：把 `docs` 换成一条开代理的 `AAAA 100::`（只给 Worker 路由用、没有源站的写法），走 Cloudflare 默认分配的 IP。Cloudflare 的文档要求 Worker 路由配一条开代理的记录；不开代理、指向优选 IP 也能用，靠的是边缘按主机名匹配路由，不是官方承诺的行为，哪天失效就这样回退。
- 宣传站放在 `nextskin.org`，照同样的形态部署，见 ADR-0055。

### 资源同源

优选只加速 nextskin.org 自己的主机名，页面只要从别的域名加载一个字体、脚本或样式，国内照样卡。所以页面的资源都和页面同源：搜索用 Starlight 自带的 Pagefind（构建时生成静态索引），字体随站点发布；不接 Algolia、Google Fonts、公共 CDN 和第三方统计。

## 后果

- 所有人 `pnpm install` 都会多装 Astro、Starlight 和 wrangler；wrangler 带着 workerd，Linux 上的二进制解压后约 140 MB。`pnpm build` 也会构建文档站。
- 文档的修正跟着发版上线，不能随时更新。
- `edge` 的 IP 要偶尔看一眼；不维护也只是变慢。
- 文档站的内容和 `docs/deploy`、启动器的帮助还有重复。把面板、systemd、Windows 的步骤迁进文档站时消除，目前记为待办。（落地时补充，2026-10-24：部署文档已经迁进文档站，`docs/deploy/` 只留 `compose.yaml`，见 ADR-0040"部署文档和面板"的同日补充。命令行一页和启动器的帮助仍有重复。）

## 考虑过的其他方案

- **Cloudflare Pages**：不支持 Worker 路由；自定义域要 CNAME 到 `pages.dev`，没法优选，除非把子域的 NS 交给国内的 DNS 服务分线路解析。
- **SaaS 优选**（自定义主机名加回退源）：要第二个域名或子域、一个回退源，还要调 SSL 模式。文档站没有源站，Worker 路由简单得多。
- **把子域的 NS 交给国内 DNS 分线路**：DNS 分到两家管理。用官方段的 anycast IP 时，海外访客本来就不受影响，用不着分线路。
- **CNAME 到公共优选域名**（如 `cf.090227.xyz`）：等于把这个主机名的解析交给对方。对方把它指向自己的服务器，就能用 HTTP-01 验证给 `docs.nextskin.org` 签出合法证书（CAA 的查询也跟着 CNAME 走）。文档站教服主下载和运行命令，内容被换掉就是供应链事故。BYOIP 段同理，而且可能失效，或被重定向到别的网站。
- **跟着 main 部署**：会写出还没发布的功能和接口。
- **文档站留在单独的仓库**：版本对不齐（插件 API 参考要从网上拉指定标签的源码包）；文档和功能不能在同一个 PR 里改；两套 CI。
- **Cloudflare 自带的 Git 构建**（Workers Builds）：构建环境不受我们控制，和现有 CI 是两套；部署时机也不好绑到"Release 发布"上。
