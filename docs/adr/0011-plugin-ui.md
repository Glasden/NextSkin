# ADR-0011 插件 UI：声明式为默认，运行时组件共享宿主 React

- 状态：已采纳（S3 通过，见 `spikes/s3-plugin-ui/README.md`；第一版只有声明式 UI，见 ADR-0033；站点的 CSP 由 ADR-0053 落地，样式不受约束）
- 日期：2026-10-16

## 背景

BS 的插件通过 `RenderingHeader` / `RenderingFooter` 向页面注入任意 HTML 和 JS。这带来两个问题：

1. **安全**：在主域运行的插件 JS，可以以当前登录用户（包括管理员）的身份做任何事，完全绕过服务端的能力模型。
2. **视觉**：每个插件各写各的界面，站点的视觉语言很快就被破坏。

## 决定

插件 UI 分三档：

| 档位 | 能做什么 | 条件 |
|---|---|---|
| 声明式（默认） | 导航项、设置页（根据设置项 schema 自动生成）、后台表格与表单、统计卡片、Markdown、往核心表单追加字段 | 无需额外能力 |
| 运行时组件 | 在指定插槽中渲染插件自己的 React 客户端组件 | 申请 `ui.script`，安装时醒目提示 |
| 官方插件 | 构建期直接 import 组件，可以是服务端组件 | 仅限随发行包分发的官方插件 |

- 声明式视图由核心用 `@nextskin/ui` 渲染，插件界面自动继承 token、暗色模式和无障碍处理。
- 不支持向页面注入任意 HTML。

### 运行时组件

**插件构建**（由 `nextskin-plugin build` 统一完成，插件作者不手动配置）：

- 每个入口打成一个单文件 ESM，不拆分代码块，按生产模式编译 JSX。
- `react`、`react/jsx-runtime`、`react/compiler-runtime`、`react-dom`、`@nextskin/ui`、`@nextskin/plugin-client` 设为外部依赖。其他依赖打进插件包，并且不能依赖与宿主共享的单例（例如需要宿主那一个 QueryClient 的库）。
- 插件需要 Tailwind 工具类时自带 CSS：用 `@reference` 引入 Tailwind 和宿主的 `theme.css`，`source(none)` 只扫描插件源码，输出的只有插件用到的工具类，不含 preflight，也不重新定义 token。
- 安装时核心再用词法分析检查一遍入口，不信任插件自己的构建工具：只允许静态导入上面六个模块名，不允许 `import()`。integrity 只覆盖入口文件，有了这条检查，"入口与登记的字节一致"才等于"插件的全部代码与登记的一致"。

**宿主**：

- 根布局在 `<head>` 里输出 import map，把上面六个模块名指向 shim。shim 导出宿主登记在 `globalThis[Symbol.for('nextskin.shared')]` 上的实例。Next App Router 在浏览器里用的是它自带的 React（`next/dist/compiled/react`，canary 版本），不是 `node_modules` 里的 `react`，插件必须共享这同一份。
- shim 由脚本在构建时生成：导出名取 Next 自带 React 开发版和生产版的并集，通道（稳定版或 experimental）与 Next 的判断一致；文件名带内容 hash，可以永久缓存。
- 插件代码只在浏览器里、水合之后加载，服务端从不执行。服务端只渲染插槽骨架。
- 每个插件挂件包一层 ErrorBoundary 和 Suspense，按"模块 URL + 导出名"做 key。渲染、effect、模块求值、模块解析、导出缺失、样式表加载失败、完整性校验失败都停在这一层。
- 超时有两道：加载（脚本和样式表）设超时；骨架显示超过同样的时长也抛错，这样插件组件自己挂起（例如 `use()` 一个永不完成的 Promise）也有期限。按模块做 key，换版本或改导出名时整层重新挂载，错误状态随之清空。
- 插件样式表由插槽自己插入并等待，计入加载超时，失败时进入错误边界。不用 React 19 的 `<link rel="stylesheet" precedence>`：React 会让同一次提交里揭示的所有边界一起等样式表，一个插件的样式表挂起会拖住别的插件；样式表 404 或 integrity 不符时，React 照样渲染，只是没有样式。
- 插件通过 `@nextskin/plugin-client` 的 `usePlugin()` 拿到自己的 id、所在插槽、指向 `/plugins/{id}` 的 `fetch` 和站内导航。插槽传给组件的 props 必须可序列化。
- 插件脚本和样式从同源的 `/plugins-assets/{id}/{version}/` 加载，插槽只接受这个前缀下的绝对路径（相对 URL 在 `import()` 和 import map 里的解析基准不同）。资源路由只提供 manifest 里登记过的文件，并解析真实路径，不跟随指向插件目录以外的符号链接。

**完整性与 CSP**：

- integrity 写在 import map 的 `integrity` 字段里，覆盖当前启用的全部插件入口，每次请求生成。只有这种方式在 Chromium、Firefox、WebKit 里都对动态 `import()` 和它的依赖强制校验；`<link rel="modulepreload" integrity>` 在 WebKit 里不校验，在 Firefox 里校验失败后 `import()` 会重新请求并执行。插件样式表用 `<link integrity>`。
- integrity 保证的是"执行的入口与安装时登记的字节一致"，不约束这段代码运行时做什么。
- import map 只在页面首次加载时生成，而 Firefox 不支持第二个 import map。页面打开之后才启用的插件版本（URL 不在本页 import map 的 integrity 里）不加载，插槽提示刷新页面。
- HTML 里 import map 之前不能有任何 modulepreload 或模块脚本，否则 Firefox 丢弃整个 import map，Chromium 跳过 integrity。React 19 会把 JSX 里的 `<link>` 提到 `<head>` 最前面，所以页面里不渲染 `<link rel="modulepreload">`；需要预加载时调用 `ReactDOM.preloadModule()`，它由客户端在 import map 之后插入。
- CSP 采用 Next 文档的 nonce 方案（`'nonce-…' 'strict-dynamic'`），import map 带 nonce，Base UI 用 `CSPProvider` 传 nonce。CSP 防的是通过数据注入的脚本，**约束不了已安装插件的代码**：插件读得到 nonce，`'strict-dynamic'` 也信任受信脚本创建的脚本，跨源脚本照样能加载。

## 后果

- 大多数插件（设置、后台管理页、表单字段）完全不需要写前端代码。
- 申请 `ui.script` 的插件在浏览器里没有隔离：它与宿主共享 DOM、全局对象和登录态，主线程死循环、改插槽外的 DOM 或全局样式都防不住。对外说明时，它等同于"以当前登录用户（包括管理员）的身份执行代码"，信任来源与 ADR-0009 相同：插件市场的签名与审核，以及安装时的醒目提示。DESIGN.md §11 的审核检查项是唯一的视觉约束。
- 运行时组件的插槽列表（`SlotName`）和每个插槽传入的 props 是公开 API 的一部分，增删遵循插件 API 的版本规则。
- 暴露给插件的共享模块也是公开 API：`@nextskin/ui` 中供插件使用的组件，以及 React 的大版本。Next 升级带来 React 大版本变化时，插件 API 升大版本。
- Next 升级时重新生成 shim，回归测试在浏览器里比较 shim 的导出与宿主实际对象的键，并检查版本号（S3 的 `tests/s3.spec.ts` 是雏形）。插件用到宿主 React 没有的导出时，模块链接失败，停在该插件的错误边界里。
- 宿主的 token 用 `@theme static` 全量输出。否则宿主自己没用到的 token 不会出现在宿主 CSS 里，插件只能用构建时写进去的后备值，宿主改 token 时它不跟着变。
- 插件更新后，已经打开的页面要刷新才能用上新版本。
- 插件挂件在水合之后才开始加载，首屏上先显示骨架。React 19 对 Suspense 从骨架切到内容有最多 300 ms 的节流。

## 退路（保留）

S3 不通过时的方案：安装插件只允许声明式 UI，运行时组件仅保留给官方插件。

## 考虑过的其他方案

- **沙箱 iframe 加独立域名**：隔离最好，但需要额外的域名配置，普通服主难以完成。留作将来的高安全档位。
- **Module Federation**：官方的 Next 适配 `nextjs-mf` 已停止活跃开发，从来没有支持过 App Router。
- **构建时把共享模块改写成读 `globalThis`（UMD 式外部化）**：不需要 shim 和导出名清单，React 增删导出时插件不在链接时失败，而是调用时才出错。代价是插件包依赖我们构建工具的私有约定，标准工具链产出的 ESM 不能直接用。完整性校验仍然只能靠 import map，import map 位置的限制也照样存在，收益不大。
- **`modulepreload` 的 integrity 属性**：只有 Chromium 可靠，见上文。
