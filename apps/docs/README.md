# NextSkin 文档站

面向服主、玩家和插件作者的文档，部署在 <https://docs.nextskin.org>。Astro + Starlight 构建的纯静态站点，正式版发布后部署到 Cloudflare Workers（ADR-0054）。最初由 NayaCcR 建成，原仓库是 [NayaCcR/NextSkin-Docs](https://github.com/NayaCcR/NextSkin-Docs)。

## 本地开发

```bash
pnpm --filter @nextskin/docs dev      # http://localhost:4321
pnpm --filter @nextskin/docs build    # 输出到 apps/docs/dist
```

`dev`、`build` 和 turbo 的 `typegen` 任务（`lint`、`typecheck` 依赖它）都先跑 `scripts/sync.ts`：从本仓库的 `packages/plugin-sdk/docs` 生成插件 API 参考，记下页脚要显示的 NextSkin 版本、SDK 版本和提交号。不联网。直接 `pnpm --filter @nextskin/docs lint` 之前先跑一次 `typegen`。

## 内容从哪来

| 内容 | 位置 | 维护方式 |
| --- | --- | --- |
| 服主指南、玩家指南、本地开发、插件总览 | `src/content/docs/` | 在这里改 |
| 插件 API 参考 | `src/content/docs/plugins/reference/` | 由 `packages/plugin-sdk/docs` 生成，不进仓库，改源文件 |
| 插件 API 参考里的插槽一览 | `src/content/docs/plugins/reference/slots.mdx` | 由插槽的登记表和下面的截图生成，不进仓库 |
| 插槽一览的截图和清单 | `src/assets/slots/` | `pnpm docs:screenshots` 生成，提交进仓库 |
| 版本和提交号 | `src/data/versions.json` | 生成，不进仓库 |

插件 API 参考的侧栏顺序、单篇的版本徽章写在 `scripts/sync.ts` 的 `order`、`changedIn` 里。

## 插槽一览的截图

插件 API 参考里的"插槽一览"给每个插槽配了截图：黑框圈出插槽，序号对应页面上的表格（ADR-0060）。

```bash
pnpm docs:screenshots   # 在仓库根目录运行
```

- 先跑 `pnpm build` 组装发行目录（turbo 会带上），再从发行目录起一个临时站点：契约用例的固定数据、一条公告，`screenshots/demo-plugin` 这个演示插件在每个插槽里放两个挂件。浏览器跑在组件截图同一个 Docker 镜像里。
- 每个页面截桌面端（1280 宽）和手机（390 宽）两张，写进 `src/assets/slots/`，连同清单 `slots.json`。不做像素比较，看过图再提交。
- 插槽的登记表（`packages/plugin-host/src/slots.ts`）和清单对不上时，`scripts/sync.ts` 会失败，`pnpm check` 和文档站的构建都过不了。新增插槽时，演示插件也要往新插槽里放挂件。
- 插槽所在的页面改版了，检查拦不住。发正式版之前看一眼，变了就重新生成。

网站上的文档对应最新的正式版：main 上改了的内容，要等下一次发版才上线。

## 外观

- 配色、圆角、硬边阴影对齐主站（`docs/DESIGN.md`），色值从 `packages/ui/src/theme.css` 转录到 `src/styles/theme.css`。主站改 token 时手工同步。
- 像素字体来自 `@nextskin/ui/fonts.css`，分片随站点发布。和主站一样只用 12、24、36、48px，不加粗：站名、页面和区块标题、侧栏分组名、表头、徽标用它，正文用系统字体。
- 页面不从别的域名加载任何资源：国内访问只加速了 nextskin.org 自己的主机名（ADR-0054）。搜索是 Starlight 自带的 Pagefind，构建时生成索引。

## 部署

`.github/workflows/docs.yml`：

- PR 和推送上，改了文档站相关的文件时只构建。
- 维护者发布正式版的 Release 以后，在那个标签上构建，部署到 Worker `nextskin-docs`。给旧的次版本发修订版时只构建、不部署。
- 部署失败后，从 Actions 页面手动运行 Docs 工作流，选那个 `v*` 标签。

部署凭据在 GitHub 的 `docs` environment（只允许 `v*` 标签）：

- secret `CLOUDFLARE_API_TOKEN`：账户的"Workers 脚本：编辑"和 nextskin.org 的"Workers 路由：编辑"，不给 DNS 权限；
- variable `CLOUDFLARE_ACCOUNT_ID`。

Worker 只有静态资源，配置在 `wrangler.jsonc`：绑路由 `docs.nextskin.org/*`，关掉 `workers.dev` 和预览地址。

## 国内访问（优选）

DNS 记录都不开代理（ADR-0054）：

| 记录 | 内容 |
| --- | --- |
| `edge.nextskin.org` A | 几个 Cloudflare 官方段里国内访问快的 IP |
| `docs.nextskin.org` CNAME | `edge.nextskin.org` |

- IP 只从 <https://www.cloudflare.com/ips/> 列出的官方段里选，不 CNAME 第三方的优选域名，不用 BYOIP 段。
- 变慢了就换 `edge` 的 A 记录：在国内网络上测延迟，或参考公共优选域名当前的解析结果，去掉不在官方段里的。换之前用 `curl --resolve docs.nextskin.org:443:<IP> https://docs.nextskin.org/` 确认能打开。
- 回退：把 `docs` 换成一条开代理的 `AAAA 100::`，走 Cloudflare 默认分配的 IP。

## 待办

- [ ] 把 `docs/deploy` 里的面板、systemd、Windows 步骤迁入本站，主仓只留一份
- [ ] 玩家指南补截图和完整步骤
- [ ] SDK 1.0 正式发布后加快照（`plugins/v1/`）和版本切换
