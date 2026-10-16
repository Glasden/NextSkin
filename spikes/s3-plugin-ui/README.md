# S3：运行时加载的插件组件共享宿主的 React

**结论：通过。** ADR-0011 的"运行时组件"档位可以开放给安装插件。插件前端打成单文件 ESM，把 `react`、`react/jsx-runtime`、`react-dom`、`@nextskin/ui`、`@nextskin/plugin-client` 设为外部依赖；宿主在根布局里输出 import map，把这些模块名指向 shim，shim 导出宿主登记在 `globalThis` 上的实例。

Next 16.4.2 的四种运行方式（`next dev` 与 `next build` + `next start`，各自用 Turbopack 和 webpack）× Chromium 153、Firefox 155、WebKit 26.6，每种组合 21 项端到端检查（其中 2 项与浏览器无关，只在 Chromium 上跑），共 236 项全部通过。

验证中有三处和 ADR 原先的设想不一样，已经改写进 ADR-0011：

1. **完整性校验只能靠 import map 的 `integrity` 字段。** `<link rel="modulepreload" integrity>` 在 WebKit 里根本不校验，在 Firefox 里校验失败后 `import()` 会重新请求并执行。import map 只在页面首次加载时生成，Firefox 又不支持第二个 import map，所以页面打开之后才启用的插件版本只能提示"刷新后生效"。
2. **HTML 里 import map 之前不能出现任何 modulepreload。** React 19 会把 JSX 里的 `<link>` 提到 `<head>` 最前面。实测这会让 Firefox 丢弃整个 import map（所有插件都解析不了 `react`），让 Chromium 跳过 integrity（被篡改的插件照样执行）。
3. **CSP 约束不了已经在主域运行的插件代码。** 插件读得到 nonce，`'strict-dynamic'` 又信任受信脚本创建的脚本，跨源脚本照样能加载。这与 ADR-0011 对 `ui.script` 的定性一致（等同于以当前用户身份行事），但文档里不能把 CSP 当成插件的安全措施。

对应 ADR：`docs/adr/0011-plugin-ui.md`。

## 运行

```bash
npm ci
node scripts/matrix.ts               # 生成 shim、构建插件，依次在 4 种模式下启动宿主并跑测试
node scripts/matrix.ts turbopack     # 只跑一种：dev / dev-webpack / turbopack / webpack
node probes/sri-probe.ts             # 不经过 Next，直接测各引擎对动态 import 完整性校验的支持
npx tsc -p tsconfig.json
```

Playwright 固定为 1.63.0，对应已缓存的 Chromium 153.0.8010.12、Firefox 155.0、WebKit 26.6。本机缺 WebKit 的系统库（libevent、libgstreamer-plugins-bad、libavif、libgav1、libyuv）时，可以不装到系统里：用 `apt-get download` 下载、`dpkg -x` 解压，复制一份 `pw_run.sh` 和 `minibrowser-wpe/MiniBrowser`，在后者的 `LD_LIBRARY_PATH` 末尾加上解压目录，再用 `S3_WEBKIT=<pw_run.sh 的路径>` 运行。Playwright 自带的 `MiniBrowser` 包装脚本会覆盖外部传入的 `LD_LIBRARY_PATH`，所以只能改这个副本。

| 文件 | 内容 |
|---|---|
| `src/host/shared.ts` | 把宿主的模块实例登记到 `globalThis[Symbol.for('nextskin.shared')]` |
| `scripts/gen-shims.ts` | 生成 shim：导出名取 Next 自带 React 开发版和生产版的并集，自有包用 esbuild 的 metafile 读出 |
| `app/layout.tsx`、`src/host/import-map.ts` | 根布局输出带 nonce 和 integrity 的 import map |
| `src/host/plugin-slot.tsx`、`src/host/loader.ts` | 插槽：水合门控、每个插件一层 ErrorBoundary + Suspense、两道超时、样式表加载、integrity 覆盖检查、插件上下文 |
| `src/host/registry.ts` | 读插件注册表（`data/plugins/installed.json`、`active.json`），生成插槽条目 |
| `proxy.ts` | 按 Next 文档生成 nonce 和 CSP |
| `app/plugins-assets/[...path]/route.ts` | 提供插件资源和 shim（正式实现里由 Hono 提供） |
| `packages/ui`、`packages/plugin-client` | `@nextskin/ui`（含 Base UI 对话框）、`@nextskin/plugin-client`（`usePlugin()`）的最小替身 |
| `scripts/build-plugins.ts` | 模拟 `nextskin-plugin build` 和安装检查：esbuild 打单文件 ESM，Tailwind 生成插件 CSS，es-module-lexer 检查入口的导入 |
| `plugins/*` | 16 个测试插件：2 个正常，11 个各出一种错，1 个演示事件处理错误，2 个做 CSP 探测 |
| `tests/s3.spec.ts` | 端到端检查 |
| `probes/sri-probe.ts` | 浏览器行为探测：modulepreload / script / import map 三种 integrity，以及第二个 import map |
| `scripts/xorigin-server.ts` | 127.0.0.1:3301 上的另一个源，CSP 探测用 |
| `scripts/matrix.ts` | 四种模式依次构建、启动、测试 |

## 结果

### 1. 共享实例

- App Router 在浏览器里用的 React 是 `19.3.0-canary-278794d7-20261002`（`next/dist/compiled/react`），不是 `node_modules` 里的 `react@19.3.1`。
- 插件拿到的 `useState`、默认导出、`jsx`、`createPortal`、`Dialog`、`usePlugin` 与宿主登记的对象全等；插件经 shim 拿到的 React 内部对象，就是渲染页面的那个 react-dom 所用的那一个（用假的 React DevTools 钩子比对，见"独立审核"一节）。hooks、transition、Suspense + `use()`、context、`createPortal`、Base UI 对话框（portal、焦点管理、Esc 关闭后焦点回到触发按钮）都正常，四种模式、三个引擎结果一致。
- 插件包里没有 React：`hello` 插件 2.5 KiB。反例 `bundled-react` 自带了 npm 上的 React，一调用 hooks 就报 `Cannot read properties of null (reading 'useState')`：两份 React 的 dispatcher 互不相通，共享是必需的。
- 插件代码只在浏览器里、水合之后加载。服务端 HTML 里只有插槽骨架，没有插件内容。
- 动态 `import()` 加上 `/* webpackIgnore: true */ /* turbopackIgnore: true */` 后，两种打包器都原样保留，交给浏览器按 import map 解析。

### 2. 错误隔离

每个插件一层 ErrorBoundary + Suspense，按"模块 URL + 导出名"做 key。超时有两道：脚本和样式表的加载超时；骨架显示超过同样时长也抛错，覆盖插件组件自己挂起的情况。三个引擎的错误类型一致（错误信息的措辞不同）：

| 插件 | 出了什么错 | 结果 |
|---|---|---|
| `render-throw` | 渲染时抛错 | `Error`，停在边界 |
| `bundled-react` | 自带一份 React | `TypeError`，停在边界 |
| `bare-import` | 导入 import map 里没有的裸模块名 | `TypeError`（解析失败） |
| `missing-export` | 从 `react` 导入宿主版本没有的名字 | `SyntaxError`（链接失败） |
| `eval-throw` | 模块求值时抛错 | `Error` |
| `tampered` | 文件内容与 integrity 不符 | `TypeError`，代码没有执行 |
| `missing-file` | 404 | `TypeError` |
| `wrong-export` | manifest 声明的导出不存在 | `PluginLoadError` |
| `hang` | 顶层 await 永不完成 | 8 秒后 `PluginLoadError`（加载超时） |
| `suspend-forever` | 模块正常，组件 `use()` 一个永不完成的 Promise | 8 秒后 `PluginLoadError`（骨架计时） |
| `effect-throw` | effect 里抛错 | `Error`，停在边界 |
| `styled` 的样式表 | 404、integrity 不符、一直不响应（测试里拦截请求） | `PluginLoadError`，只有这个插件进入错误状态 |
| `event-throw` | 事件处理函数里抛错 | 不触发边界（React 的设计），组件保持可用，错误进入 window 的 error 事件 |

以上情况下，宿主和其他插件都照常可以交互。

插件样式表一开始交给 React 19 的 `<link rel="stylesheet" precedence>` 加载，独立复核发现两个问题：React 让同一次提交里揭示的所有边界一起等样式表，`styled` 的样式表挂起时，独立的 `hello` 也一直停在骨架；样式表 404 或 integrity 不符时，React 照样渲染，插件显示成没有样式的样子，没有任何错误。现在改由加载器自己插入 `<link>`、等 `load`/`error` 事件，计入加载超时。

同一个页面里的代码做不到的隔离：主线程死循环、改插槽以外的 DOM 或全局样式、改全局对象（例如替换 `window.fetch`）。这些只能靠审核（DESIGN.md §11 的检查项）和插件市场的签名。

### 3. 软导航与插件换代

- import map 在根布局里，软导航不会重新渲染根布局，import map 一直有效。同一个模块在不同页面、不同插槽之间复用，只加载一次。
- 插件换代（ADR-0009 的整代切换）后 URL 里的版本号变了：
  - 不校验 integrity 时，`router.refresh()` 之后插槽直接换成新版本，不刷新整页；
  - 开启 import map integrity 时（推荐），新版本的 URL 不在本页的 import map 里，插槽显示"这个插件已更新，刷新页面后生效"，刷新后加载新版本。
- 插槽按"模块 URL + 导出名"做 key，换版本时整层重新挂载：先显示骨架，再显示新版本，骨架计时同样生效。代价是不校验 integrity 时，换代那一下会闪出骨架。

### 4. 完整性校验

`probes/sri-probe.ts` 的结果（页面带与宿主相同的 nonce + `'strict-dynamic'` CSP）：

| 方式 | Chromium 153 | Firefox 155 | WebKit 26.6 |
|---|---|---|---|
| import map `integrity`，动态 `import()` | 拒绝 | 拒绝 | 拒绝 |
| import map `integrity`，被导入的依赖 | 拒绝 | 拒绝 | 拒绝 |
| `<link rel="modulepreload" integrity>`，之后 `import()` | `error` 事件，`import()` 失败 | `error` 事件，但 `import()` 重新请求并**执行** | **不校验**：`load` 事件，执行 |
| `<script type="module" integrity>`，之后 `import()` | `error` 事件，`import()` 失败 | `error` 事件，`import()` 重新请求并**执行** | `error` 事件，`import()` 重新请求并**执行** |
| 加载过模块之后再插入第二个 import map | 映射和 integrity 都生效 | **不支持**（"Multiple import maps are not allowed"） | 映射和 integrity 都生效 |

所以宿主的做法是：

- 每次请求生成 import map，`integrity` 里写上当前启用的全部插件入口（不只是本页用到的，软导航到别的页面时也覆盖）；
- 插槽加载前检查 URL 是否在本页 import map 的 `integrity` 里，不在就不加载，提示刷新；
- 插件样式表用 `<link rel="stylesheet" integrity>`，三个引擎在 integrity 不符时都触发 `error`，插件进入错误状态；
- 插槽只接受同源 `/plugins-assets/` 下的绝对路径，覆盖检查和 `import()` 用的是同一个规范化后的 URL。相对 URL 在 `import()` 里按调用方模块的地址解析，在 import map 里按页面地址解析，两者可能指向不同的文件（复核发现 3）。

integrity 只覆盖入口文件本身：入口静态导入或 `import()` 的其他文件，只要不在 import map 的 `integrity` 里，浏览器都照常加载。所以安装时要检查入口：只允许静态导入 6 个共享模块名，不允许 `import()`（`scripts/build-plugins.ts` 用 es-module-lexer 做了这一步，正式实现由核心在安装时做，不信任插件的构建工具）。满足这一条，"入口与登记的字节一致"才等于"插件的全部代码与登记的一致"。它约束的是登记的代码长什么样，约束不了这段代码运行时做什么，见下面的 CSP 一节。

在宿主里，被篡改的 `tampered` 插件在三个引擎里都被拒绝、没有执行；对照组（关掉 integrity）里它会执行。

### 5. import map 必须排在一切模块加载之前

Next 自己的脚本都是普通的 `async` 脚本，不触发模块加载；import map 在 `<head>` 里，插槽在 `<body>` 里，水合不可能早于 import map 被解析。风险来自 React 19 对 `<link>` 的提升：

| 写法 | HTML 里的位置 | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| 页面里渲染 `<link rel="modulepreload">` | 被提到 import map **之前** | 映射生效，但 integrity 被跳过，篡改的插件执行 | 整个 import map 被丢弃（"Import maps are not allowed after a module load or preload has started"），所有插件失败 | 正常 |
| 服务端组件里调用 `ReactDOM.preloadModule()` | 不写进 HTML，由客户端处理 RSC 载荷时插入，在 import map 之后 | 正常 | 正常 | 正常 |

有一项守护测试检查 HTML 里 import map 之前没有任何 modulepreload 或 `type="module"` 脚本。将来 Next 改用 ESM 分块输出，或者某个依赖往 `<head>` 里塞 modulepreload，这项测试会失败。

### 6. CSP

采用 Next 文档的写法：`proxy.ts` 为每个请求生成 nonce，`script-src 'self' 'nonce-…' 'strict-dynamic'`，`style-src 'self' 'nonce-…'`。import map 是内联脚本，要带 nonce；Next 自己的脚本会自动带上。生产模式下三个引擎在插件加载过程中都没有 CSP 违规。dev 模式下 Next 开发工具的 `<nextjs-portal>` 自己的内联样式违反 `style-src`，与插件无关。

已经在主域运行的插件代码能做什么（`xorigin-*` 插件，生产模式，三个引擎一致）：

| 插件代码做的事 | 结果 |
|---|---|
| 静态 `import` 另一个源的模块 | 放行 |
| 动态 `import()` 另一个源的模块 | 放行 |
| 插入不带 nonce 的 `<script src="另一个源">` | 放行（`'strict-dynamic'` 信任受信脚本创建的脚本） |
| 读取 nonce（`HTMLElement.nonce`） | 读得到 |
| 插入带 nonce 的 `<script>` | 放行 |
| `fetch` 另一个源 | 拦截（`connect-src 'self'`） |
| 加载另一个源的图片 | 拦截（`img-src`） |

nonce 读得到，任何基于 nonce 的策略都拦不住插件加载脚本。只用 hash、不用 nonce 的策略能限制脚本的来源，但拦不住同源 API 的滥用，也拦不住跳转（`location.href = …`）带出数据，不值得为此放弃动态渲染。CSP 在这里的作用是防住通过数据注入的脚本（XSS），不是插件的边界。

一个细节：dev 模式的 `connect-src` 带了 `ws:`（给 HMR 用），WebKit 按 CSP3 规范让 `ws:` 也匹配 http(s)，于是放行了跨源 `fetch`；Chromium 和 Firefox 不这样匹配。生产配置没有 `ws:`，三个引擎都拦截。

### 7. 样式

- 宿主的 Tailwind 只扫描自己的源码（`source(none)` 加显式的 `@source`）。真实部署里宿主构建时看不到运行时安装的插件，插件用到而宿主没用到的工具类（测试里的 `grid-cols-7`、`border-dashed`、`aspect-square`）在宿主 CSS 里不存在，所以插件必须自带 CSS。
- 插件 CSS 的构建入口：

  ```css
  @reference "tailwindcss";
  @reference "<宿主>/packages/ui/src/theme.css";
  @import "tailwindcss/utilities" layer(utilities) source(none);
  @source "<插件源码目录>";
  ```

  输出只有插件用到的工具类（`styled` 插件 1.3 KiB），没有 preflight，也不重新定义 token，引用 token 时带构建时的值作后备：`var(--color-warning, #b86e00)`。工具类落在与宿主同名的 `utilities` 层里，层的顺序由宿主 CSS 先声明。去掉 `source(none)` 时，Tailwind 会自动扫描整个工作目录，把宿主的工具类也打进插件 CSS（7.2 KiB）。
- 宿主的 token 要用 `@theme static` 全量输出。否则宿主自己没用到的 token（测试里的 `warning`）不会出现在宿主 CSS 里，插件只能用后备值，宿主改了 token 它也不跟着变。
- 切换 `data-theme` 后，插件的颜色随之变化（`border-warning` 从 `rgb(184, 110, 0)` 变为 `rgb(240, 165, 58)`），宿主定义的 `dark:` 变体在插件里也能用。插件里用的宿主 `Button` 同样随主题变化。
- 插件 CSS 由加载器插入 `<head>`，和插件脚本一起等加载完再显示，不会闪出无样式的内容（不用 React 的 `precedence`，原因见第 2 节）。
- 风险：插件 CSS 和宿主 CSS 由不同版本的 Tailwind 生成时，`--tw-*` 内部变量和 `@layer properties` 的内容可能不一致。构建工具应锁定与插件 API 大版本匹配的 Tailwind 版本。

### 8. shim 与 Next 升级

- 导出名在构建时生成：`react` 46 个（开发版比生产版多 `act` 和 `captureOwnerStack`），`react/jsx-runtime` 3 个，`react/compiler-runtime` 1 个，`react-dom` 15 个。ESM 的具名导出必须静态列出，所以必须生成，不能在运行时动态导出。
- Next 在打开 `taint`、`transitionIndicator`、`gestureTransition`、`blockingSSR` 这几个实验特性时，改用 `react-experimental`（多 5 个导出）。生成脚本要和 Next 用同样的判断选通道（`next/dist/lib/needs-experimental-react.js`）。
- 回归测试在浏览器里逐个比较 shim 的导出和宿主实际对象的键，并检查 React 版本号与生成时一致。Next 升级后忘了重新生成 shim，这项测试会失败。
- 插件按更新的 React 编写、用了宿主没有的导出时，模块链接失败（`missing-export` 用例），停在该插件的边界里，不影响页面。
- 共享的 React 大版本因此是插件 API 的一部分：Next 升级带来 React 大版本变化时，插件 API 要升大版本。

### 9. 性能

生产构建，本机回环，每种组合测一次（机器上同时运行着其他服务，数字只看量级）。首页共有 15 个插件挂件，加载 20 个插件资源（14 个入口、1 个样式表、5 个 shim），合计约 17 KB：

| 从导航开始计时 | Chromium | Firefox | WebKit |
|---|---|---|---|
| 第一个插件请求发出 | 约 180 ms | 约 185 ms | 260–290 ms |
| hello 入口和它用到的 shim 的请求时间窗 | 约 100 ms | 约 60 ms | 约 95 ms |
| hello 可交互 | 530–540 ms | 545–555 ms | 625–675 ms |

Turbopack 和 webpack 的构建结果没有可见差别。

- 插件要等水合之后才开始加载，第一个请求排在水合后面。
- 请求结束到可交互之间还有约 300 ms，主要是 React 19 对 Suspense 揭示的节流（`FALLBACK_THROTTLE_MS = 300`）：骨架换成内容至少要等这么久，好让同一时段完成的多个边界一起揭示。
- 在服务端组件里调用 `ReactDOM.preloadModule()`，第一个请求能提前 50–90 ms，但可交互时间没有变化：入口先到了，shim 还是要等解析入口之后才请求，最后又被节流抹平。目前不值得做，以后插件多了再看。

## 对设计的约束（已写入 ADR-0011）

1. 插件前端：单文件 ESM，生产模式 JSX，6 个共享模块设为外部依赖，其余依赖自己打包且不依赖宿主的单例；需要工具类时按上面的方式自带 CSS。全部由 `nextskin-plugin build` 完成。
2. 宿主：根布局在 `<head>` 里输出带 nonce 和 integrity 的 import map，每次请求生成；shim 在构建时从 Next 自带的那份 React 生成。
3. 插槽：水合之后才加载；每个插件一层 ErrorBoundary + Suspense，按模块做 key；加载和显示两道超时；样式表由加载器自己加载；URL 不在本页 import map 的 integrity 里时不加载，提示刷新。
4. 页面里不渲染 `<link rel="modulepreload">`，预加载用 `ReactDOM.preloadModule()`；守护测试检查 import map 之前没有模块加载。
5. token 用 `@theme static` 全量输出。
6. 对外说明 `ui.script` 时不把 CSP 列为保护措施。

## 遗留问题

- **资源路由**：正式实现只应提供 manifest 里登记过的文件。本 spike 的路由按扩展名放行插件目录里的任何 `.js`、`.css`（已解析真实路径，不跟随指向 `data/` 以外的符号链接）。
- **同一版本号重新发布不同内容**：资源按永久缓存提供，浏览器会拿到旧文件、integrity 对不上而拒绝。插件市场应禁止重发同一版本，或者把内容 hash 放进路径。
- **同一请求里两次读注册表**：根布局生成 import map 和页面生成插槽条目各读一次。中间正好发生换代时，插槽会提示刷新（失败关闭）。正式实现应在一个请求内使用同一份注册表快照。
- **插槽 props 的类型**：每个 `SlotName` 传给组件什么 props，还没有写进插件 SDK。
- **需要单例的第三方库**（例如 TanStack Query 的 QueryClient）：不共享。插件需要访问宿主数据时，由 `@nextskin/plugin-client` 提供 hooks。
- **插件开发体验**：`nextskin-plugin dev`（对着运行中的宿主热更新插件）没有验证。另外，dev 模式下热更新了宿主的共享模块（例如改了 `@nextskin/ui` 的组件）之后，已经求值的 shim 仍然导出旧的对象，要刷新页面。
- **SRI 开关**：spike 用 cookie `s3-sri` 在"校验"和"不校验"之间切换以便对照，页面中途切换时 lazy 缓存不会跟着变。正式实现里校验始终打开，不提供这个开关。
- **错误上报与熔断**（ADR-0009）：插槽只在 `componentDidCatch` 里留了位置。
- 只在 Node 24.21 上跑过。插件在浏览器里运行，与 Node 版本无关；shim 生成脚本只用到 `require`。
- Next 16.4 的 `next dev` 会在项目目录生成 `AGENTS.md`（`agentRules: false` 可关闭），并自动改写 `tsconfig.json`（加 `allowJs` 和 `.next` 类型目录）。搭脚手架时要注意。

## 独立审核

由 Codex（`gpt-6-astra`，xhigh）在修复前的快照上独立审核，审核提示词只给了要验证的结论和不变量，没有给实现方的说明。这次没有被内容安全过滤拦截，七条发现都附了探测脚本，主会话逐条复现确认，修复后用同样的脚本复查，并在 `tests/s3.spec.ts` 里补了回归用例。**修复后没有再做独立复审。**

| # | 问题 | 后果 | 修复 |
|---|---|---|---|
| 1 | integrity 只登记了入口，入口的静态依赖和 `import()` 不在覆盖范围 | 未经校验的代码可以随插件一起执行 | 安装检查：入口只允许静态导入共享模块，不允许 `import()` |
| 2 | 插件样式表交给 React 的 `precedence` 加载 | 一个插件的样式表挂起会拖住其他插件；样式表 404 或 integrity 不符时没有错误，只是没有样式 | 加载器自己插入并等待样式表，计入超时，失败进入错误边界 |
| 3 | 覆盖检查按页面地址解析相对 URL，`import()` 按加载器模块的地址解析 | 用已登记文件的 integrity 通过检查，实际执行另一个文件 | URL 先规范化成绝对地址，两处用同一个；只接受同源 `/plugins-assets/` |
| 4 | 超时只包住模块加载，组件自己挂起不受约束 | 插槽可以永远停在骨架 | 骨架显示超时也抛错 |
| 5 | 资源路由的字符串校验挡不住符号链接 | 能读到 `data/` 以外的文件 | 解析真实路径后再确认仍在 `data/` 里 |
| 6 | lazy 缓存按"URL + 导出名"区分，错误边界只在 URL 变化时重置 | 同一版本改正导出名之后，错误状态无法恢复 | 错误边界按"URL + 导出名"做 key |
| 7 | shim 导出名检查用白名单放过了开发版独有的 `act`、`captureOwnerStack` | 生产版的键并不完全一致，白名单里的名字变化测不出来 | 生成时分别记下开发版和生产版的导出名，测试按运行模式精确比较 |

复核还指出：第一个测试只证明 shim 转发到了登记的对象，没有直接证明登记的对象就是渲染器用的那一份。现在测试注入一个假的 React DevTools 钩子，拿到渲染页面的那个 react-dom 注册时交出的 `currentDispatcherRef`，与插件经 shim 拿到的 React 内部对象做全等比较（dev 模式下 Next 开发工具的浮层是另一个渲染器，按提交的根容器区分）。
