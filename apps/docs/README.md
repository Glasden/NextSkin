# NextSkin 文档站

NextSkin 的公开文档。Astro + Starlight，构建成纯静态站点，部署在 Cloudflare Pages。

## 本地开发

```bash
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` 先从主仓拉取 `packages/plugin-sdk/docs` 生成 API 参考，再启动 Astro。只改指南时这条命令一样适用；参考页是生成物，不要手改。

## 内容从哪来

| 内容 | 位置 | 维护方式 |
| --- | --- | --- |
| 服主指南、玩家指南、本地开发 | `src/content/docs/guide`、`players`、`development.md` | 在本仓库改 |
| 插件总览 | `src/content/docs/plugins/index.md` | 在本仓库改 |
| 插件 API 参考 | `src/content/docs/plugins/reference` | 构建时生成，已 gitignore |
| SDK 版本 | `src/data/sdk-meta.json` | 构建时生成，已 gitignore，分组徽章读它 |

`scripts/fetch-sdk-docs.mjs` 做的事：

- 下载 `NEXTSKIN_REPO`（默认 `Glasden/NextSkin`）在 `NEXTSKIN_REF`（默认 `main`）上的源码包；
- 读 `packages/plugin-sdk/docs/*.md`，生成 frontmatter：标题、侧栏顺序、版本徽章、`editUrl` 指回主仓源文件；
- 把 `./x.md` 和 `./x.md#锚点` 改写成 `/plugins/reference/x/`；
- 生成目录写进 `.gitignore`；拉不到文档时构建直接失败，不会生成空侧栏。

想用自己 fork 的文档本地预览：

```bash
# bash
NEXTSKIN_REPO=NayaCcR/NextSkinG NEXTSKIN_REF=main pnpm build

# PowerShell
$env:NEXTSKIN_REPO='NayaCcR/NextSkinG'; $env:NEXTSKIN_REF='main'; pnpm build
```

## 版本徽章

版本号只挂在侧栏“插件 API 参考”这个分组上，单篇默认不标。某篇内容在某版有变化时，在 `scripts/fetch-sdk-docs.mjs` 的 `changedIn` 里加一条（例如 `'context': 'v1.1.0'`），只有那一篇会在标题旁出现徽章。

## 视觉

页头标志、favicon、配色和圆角对齐主站：`src/assets/logo.svg`、`src/assets/logo-dark.svg` 与 `public/favicon.svg` 转录自 `apps/web/public/icon.svg`，`src/styles/theme.css` 的色值取自 `packages/ui/src/theme.css`。主站改 token 时手工同步，没有构建期依赖。像素字体分片目前没有随主仓提交，所以文档站沿用系统字体；字体进仓后把 `fonts.css` 和分片复制过来即可。

## 发布与部署

### 第一次

1. 推送仓库（remote 已经是 `https://github.com/NayaCcR/NextSkin-Docs.git`）：

   ```bash
   git add -A
   git commit -m "docs: 初始化文档站"
   git push -u origin main
   ```

2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git，选 `NayaCcR/NextSkin-Docs`，分支 `main`。
3. 构建配置：

   | 设置 | 值 |
   | --- | --- |
   | Root directory | `/` |
   | Build command | `pnpm install --frozen-lockfile && pnpm build` |
   | Build output | `dist` |
   | 环境变量 | `NODE_VERSION=24`；生产环境按需加 `NEXTSKIN_REF=v1.0.0` |

4. 保存并部署。之后每次 push `main` 自动构建，PR 会生成预览部署。
5. 自定义域：Pages 项目 → Custom domains → 添加 `docs.nextskin.org`，按提示在 DNS 加 CNAME。`astro.config.mjs` 的默认 `site` 已经是这个地址；换域名时改默认值或注入 `SITE_URL`。
6. Deploy hook：Pages 项目 → Settings → Builds & deployments → Deploy hooks → Add（分支 `main`），复制 URL 到主仓 GitHub → Settings → Secrets and variables → Actions，新建 `PAGES_DEPLOY_HOOK`。

预览部署跟随分支。生产环境可以固定 `NEXTSKIN_REF=v1.0.0` 这类 tag，避免未发布的接口混进正式文档；不设置时跟随 `main`。Cloudflare 会按 `package.json` 的 `packageManager` 自动装对应版本的 pnpm（日志里会打印 `pnpm@12.8.1`），构建命令里不要再 `npm i -g pnpm`，否则会和已装好的同版本冲突（`EEXIST`）。

### 日常

- 只改本仓库的文档：push `main`，Pages 自己构建。
- 主仓 `packages/plugin-sdk/docs/**` 变化：主仓 `.github/workflows/docs-rebuild.yml` 调 Deploy Hook 触发重建。
- 回退：Pages → Deployments → 选上一个正常部署 → Rollback；或 revert 对应提交。

### Workers（静态资源）

如果项目建成了 Worker 而不是 Pages，构建命令不变，部署命令用 
px wrangler@4 deploy，配置在 wrangler.jsonc：ssets.directory 指 ./dist，
ot_found_handling 用 404-page。有这份配置时 wrangler 不会再去跑 stro add cloudflare，也就不会因为 pnpm 12 拒绝执行 esbuild/workerd 的构建脚本而报 ERR_PNPM_IGNORED_BUILDS。

## 页脚与文档版本

页脚在 `src/components/Footer.astro`，显示：文档版本（构建日期，`Asia/Shanghai`）· 提交 sha（链到 commit）· 同步的插件 SDK 版本 · 文档仓库链接。

全部在构建期生成，不需要手写：

- 日期取构建时间；
- 提交号取 `CF_PAGES_COMMIT_SHA`，本地构建时取 `git rev-parse --short HEAD`；
- SDK 版本来自 `src/data/sdk-meta.json`，由 `pnpm sync` 从主仓 `packages/plugin-sdk/package.json` 读取。

要换成语义版本号（`v0.1.0` 这种）时，给仓库打 tag，把日期那段换成 `git describe --tags --always` 即可；发版时打 tag，文件不用改。

## 搜索

Starlight 自带 Pagefind，构建时生成静态索引，不需要外部服务。上线后拿 `set-role`、`提权`、`Yggdrasil`、`拦截点` 实测召回；效果不够再考虑 Algolia DocSearch。

## 待办

- [ ] 把 `docs/deploy` 里的面板、systemd、Windows 步骤迁入本站，主仓只留一份
- [ ] 玩家指南补截图和完整步骤
- [ ] 配置自定义域，替换 `SITE_URL` 默认值
- [ ] SDK 1.0 正式发布后加快照（`plugins/v1/`）和版本切换
