# NextSkin 宣传站

部署在 <https://nextskin.org>。Astro 静态站，场景是 React 组件，正式版发布后部署到 Cloudflare Workers（ADR-0055）。

桌面上是翻页的播放器：一页一个场景，滚轮给蓄力条充能，满了翻页，播完停留几秒自动翻。窄屏、触屏、开了"减少动态效果"的设备上只给静帧和文字，播放器不水合。

## 本地开发

```bash
pnpm --filter @nextskin/site dev      # http://localhost:4321
pnpm --filter @nextskin/site build    # 输出到 apps/site/dist
pnpm --filter @nextskin/site preview  # 看构建产物
```

`dev`、`build` 和 turbo 的 `typegen` 任务（`lint`、`typecheck` 依赖它）都先跑 `scripts/generate.ts`：用仓库里的代码算出画面上的数据和出图，写到 `src/gen/repo-data.json` 和 `public/gen/`，两处都不进仓库。不联网，两秒左右。直接 `pnpm --filter @nextskin/site lint` 之前先跑一次 `typegen`。

开发服务器偶尔报 `504 (Outdated Optimize Dep)`：停掉它，删 `node_modules/.vite` 再启动，或者改用 `build` 加 `preview`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/scenes/` | 一页一个文件，导出一个 `Page`（`page.ts`）：场景组件、动画长度、停留秒数、章节号、静帧和读屏用的文字 |
| `src/scenes/pages.ts` | 页的顺序 |
| `src/stage/` | 场景共用的东西：时间单位和阶跃动效（`time.ts`）、排版原语（`ui.tsx`）、出图和标志（`skin.tsx`）、1280×720 的画面（`frame.tsx`） |
| `src/player/` | 桌面的播放器：缩放、时钟、蓄力翻页、键盘、锚点、暂停 |
| `src/pages/index.astro` | 唯一的页面：播放器加静帧版 |
| `src/links.ts` | 首屏和尾页的三个入口 |
| `scripts/` | 构建前的生成脚本 |

## 写场景

- 场景只按 `useT()` 给的这一页的秒数算画面，不存状态，不自己起定时器。静帧就是把 `t` 设成 `duration` 渲染一遍。
- 时间沿用介绍视频的 126 BPM 网格当刻度：`barsFrom(n)` 以后按视频的小节号写时刻。网站上没有配乐，不卡点。
- 动效是阶跃的（`steps`、`enter`），不用缓动和淡入淡出（DESIGN.md）。
- 按 1280×720 排版，尺寸写在内联样式里；颜色只用 `theme.css` 的 token 类（不变量 10，lint 守着）。材质自己的颜色从生成的数据里取，写进 SVG 的 `fill`。像素字体只用 12px 的整数倍。
- 画面上的数字、hash、SQL、用例标题从 `repo-data.json` 取，不手写。手写的文案（功能、命令、退避时间这些）要和仓库的代码对得上，写之前去代码里核对。
- `text.body` 是手机上静帧下面的正文，也是读屏软件和搜索引擎读到的内容，要能脱离画面读懂。反引号括起来的是代码。
- 新加一页：写场景文件，加进 `pages.ts`，给一个锚点 `id`；同步改 ADR-0055 的页表。

## 看画面

- 地址加 `#<页的 id>` 直接打开那一页，例如 `#raster`。看过的页再回去时停在最后一帧。
- 播放器的条件写在 `src/player/mode.ts`（`PLAYER_MEDIA`），`src/styles/site.css` 用同一个条件切换两种版式，改的时候两边一起改。
- 静帧版：把窗口缩到 960px 以下，或者在开发者工具里模拟"减少动态效果"。

## 部署

`.github/workflows/site.yml`，时机和文档站一样：

- PR 和推送上，改了宣传站或者生成脚本用到的代码时只构建。
- 维护者发布正式版的 Release 以后，在那个标签上构建，部署到 Worker `nextskin-site`。给旧的次版本发修订版时只构建、不部署。
- 部署失败后，从 Actions 页面手动运行 Site 工作流，选那个 `v*` 标签。

凭据和文档站共用 GitHub 的 `docs` environment（见 `apps/docs/README.md`）。Worker 只有静态资源，配置在 `wrangler.jsonc`：绑路由 `nextskin.org/*`，关掉 `workers.dev` 和预览地址。

`www.nextskin.org` 由另一个 Worker `nextskin-www`（`www/`）全部 301 到根域名，保留路径和查询参数。工作流部署宣传站时一起部署它；手动部署是 `pnpm exec wrangler deploy -c www/wrangler.jsonc`。

根域名和 `www` 的 DNS 记录都不开代理，和 `docs` 一样解析到 `edge.nextskin.org` 那组 IP：两条都是 CNAME 指向 `edge`，Cloudflare 在根域名上把它拉平成 A 记录，和根域名上的 MX、TXT 共存。换 IP 只改 `edge`。

## 待办

- [ ] 由工作流部署：线上现在是手动 `wrangler deploy` 的版本，等包含 `apps/site` 的正式版发布后改由工作流部署
