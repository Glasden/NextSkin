# ADR-0058 结构主题：主题可以选直角、粗边框、静止时带阴影的卡片，交的是枚举不是 CSS；强调色拆出色块 `accent-fill`；高对比由官方插件"更多配色"提供

- 状态：已采纳
- 日期：2026-10-23
- 补充 ADR-0057：做它"不做"里留给另一份 ADR 的改结构的主题（高对比）
- 补充 ADR-0033：`ui.themes` 多一个可选字段，`ThemeColor` 多两个颜色，趁 SDK 候选期进 1.0

## 背景

ADR-0057 落地以后，插件能用数据声明配色主题，SDK 是 `1.0.0-rc.5`。它的"不做"第一条是改结构的主题：DESIGN.md 附录的高对比除了颜色，还要边框一律 2px、圆角一律为 0、卡片静止时就带 4px 阴影、选中的卡片用 4px 黑框，链接和勾选框的选中态改用正文色。这些写在组件的类里，不是 token。

动手前核对了现状（Tailwind 4.3，`packages/ui/src/theme.css` 是 `@theme static`）：
- **圆角已经读变量**：`rounded-sm` 编出来是 `border-radius: var(--radius-sm)`，在 `[data-theme]` 上覆盖 `--radius-*` 就能改。
- **边框粗细写死**：`border` 编出来是 `border-width: 1px`。Tailwind 会读 `--default-border-width`，把它设成变量以后，`border`、`border-b`、`divide-y` 都改读变量（试编过）；`border-2` 这种写数字的照旧写死。
- **阴影被内联**：`shadow-pixel-lg` 编出来是 `--tw-shadow: 4px 4px 0 0 var(--tw-shadow-color, var(--color-shadow))`，覆盖 `--shadow-*` 不起作用。只有写成 `shadow-(--变量)` 才读变量。
- **页面上的面板是手拼的**：`apps/web/app` 里 28 个文件约 40 处 `rounded-md border border-border bg-surface…`，没有面板组件。`apps/web` 里的 `rounded-md` 全都是面板。
- **强调色身兼两职**：链接、图标、勾选框和开关的选中态、选中的卡片的框和角标、Tabs 和 Nav 的指示条，是画在表面上的，要和表面分得开；主要按钮、标志的前脸、领奖台第一名的台阶、Steps 的当前步骤，是一大块色，上面有自己的字或图形。附录的荧光黄绿 `#d4ff1e` 在白底上只有 1.16:1，照原样交给 `checkTheme`，只差 `accent` 对 `bg`、`surface` 两项。
- 附录的高对比还改了 `stage` 和棋盘格，ADR-0057 已经把它们锁住。
- 按 1px 边框对齐的写法只有一处：Tabs 指示条的 `-bottom-px`。

要定的：开放哪些结构、插件怎么交、强调色怎么拆、怎么检查、CSS 怎么生成、组件和页面怎么改、截图怎么拍、高对比放在哪里。

## 决定

### 范围

这次做：
- `ui.themes` 的每套主题多一个可选的 `structure`：圆角、边框、卡片三项，每项两个取值；
- 新颜色 `accent-fill`、`accent-fill-fg`，主要按钮这类色块改用它们；
- theme.css 的结构变量，组件改读变量，新组件 Panel，页面上手拼的面板换成它；
- `packages/theme` 的推导、检查和生成 CSS 跟着加；
- Storybook 和截图回归加上"结构全开"；
- 官方插件"更多配色"加一套高对比，作为这个字段的参考插件。

不做：
- 字体、字号、间距、控件高度、动效跟着主题变；阴影的偏移和方向也不变，只有静止时带不带。
- 亮色、暗色用不同的结构：边框粗细会改变盒子的尺寸，切换亮暗时页面不该跳。
- 按系统的 `prefers-contrast: more` 自动换成高对比：主题在服务端定下来，跟随系统要像亮暗那样在浏览器里判断，还要定它和用户的选择谁优先。以后需要再议。
- 专门适配 Windows 的强制颜色模式（`forced-colors`）：那是浏览器替换全部颜色，靠的是组件不只用颜色表达状态（DESIGN.md §9），和主题无关。
- 用户在主题之外单独开关结构（比如只要粗边框）：多一个要和主题组合的维度，见"考虑过的其他方案"。
- 运行时组件、自定义 CSS：照旧另做。

### 结构的形状

每项都可以省略，省略的取钻石青：

| 键 | 取值 | 钻石青 | 改变什么 |
|---|---|---|---|
| `radius` | `'rounded'`、`'square'` | `rounded` | `square` 时 2px、4px 的圆角都变直角 |
| `borders` | `'thin'`、`'thick'` | `thin` | `thick` 时常规边框（`border`，1px）变 2px，选中的卡片和选项的框跟着从 2px 变 4px（总是常规边框的两倍）；本来就是 2px 的（勾选框、开关、进度条、虚线的投放区）不变 |
| `cards` | `'flat'`、`'raised'` | `flat` | `raised` 时面板和卡片静止就带 4px 硬边阴影（`shadow` 色），悬停照旧上移 2px |

- **交枚举，不交 CSS 值**：每个取值都落在 DESIGN.md §2 的范围里（4px 网格、0–4px 圆角、不模糊的位移阴影），哪种组合都合规，不需要检查。生成的 CSS 里只有核心自己写的值，和颜色只收 `#rrggbb` 是同一个道理（ADR-0057）。
- **三项互不影响**：每项只改自己的变量（见"CSS"），八种组合不用逐一设计。
- **CSS 变量名不进 SDK**：插件交的是枚举。变量叫什么、组件怎么用，核心以后可以改，不是大版本。
- 以后加取值（比如 3px 的边框）是次版本，同 ADR-0057 的"只放宽"；删除、改名取值是大版本。

### 强调色拆出色块

新颜色 `accent-fill` 和 `accent-fill-fg`：一大块强调色，上面有自己的字或图形，靠字和阴影辨认，不要求和表面分得开。只用在这几处：
- Button 和 ButtonLink 的 primary；
- 标志的前脸（`accent-fill`）和眼睛（`accent-fill-fg`）；
- 领奖台第一名的台阶、Steps 的当前步骤；
- ThemeCard 小样里的按钮。

其余用强调色的地方都不改，`accent` 从此明确指"画在表面上的强调色"：链接、图标，勾选框、单选、开关的选中态，选中的卡片的框和角标，Tabs、Nav、Pagination 的指示条，进度条，未读的方块，页头铃铛的计数。`accent-fg` 是画在这些选中态上的字和勾。

- **推导**：主题没写时，`accent-fill` 等于这个主题的 `accent`，`accent-fill-fg` 等于 `accent-fg`。钴蓝、洋红画出来和以前一模一样。
- **检查**加两条：`accent-fill-fg` 对 `accent-fill` 不低于 4.5:1；`accent-fill` 和 `danger` 在 OKLab 里相距不小于 0.12（主要按钮和删除按钮）。原有的检查都不变。没写这两个颜色的主题，新加的两条和原有的 `accent-fg` 对 `accent`、`accent` 和 `danger` 查的是同一组值，以前通过的照样通过，不算收紧。
- `accent-fill` 对 `surface` 不查：高对比的荧光色在白底上就是 1.16:1，主要按钮靠黑字和硬边阴影辨认。
- `focus`、`accent-subtle` 的推导不变，仍然从 `accent` 来。
- `ThemeColor` 从 20 个变成 22 个，theme.css 多两个 token，DESIGN.md §3 的表由 `pnpm design:sync` 生成。

拆出来的是色块而不是"强调色文字"：色块只有上面几处，画在表面上的有四十来处；这样原有的检查一条不用动，`accent` 原来的意思大部分照旧。

### 高对比

官方插件"更多配色"（`plugins/color-themes`）加一套 `color-themes/high-contrast`，`structure` 三项全开：

```ts
{
  name: 'high-contrast',
  label: 'themes.highContrast',
  structure: { radius: 'square', borders: 'thick', cards: 'raised' },
  colors: {
    light: { accent: '#000000', 'accent-fg': '#ffffff', 'accent-fill': '#d4ff1e', 'accent-fill-fg': '#000000', /* … */ },
    dark: { accent: '#d4ff1e', 'accent-fg': '#000000', /* … */ },
  },
}
```

其余颜色取附录，改动三处：
- 亮色下 `accent` 用黑色，荧光色只给 `accent-fill`。附录说的"链接改用正文色、勾选框的选中态用正文色、选中的卡片用黑框"都由此得到，不用另设开关。
- 暗色下荧光色在近黑的底上约 17:1，`accent` 照旧用它，`accent-fill` 跟着推导。
- `stage`、`checker-a`、`checker-b` 用钻石青：ADR-0057 已经锁住。

照这组值跑 `checkTheme`，现有的 25 组对比度、明暗方向和距离都通过；新加的两条是 18.1:1，以及 0.51 / 0.43（亮 / 暗）。取值在实现时写进 DESIGN.md 附录，替换现在那张表。

放进官方插件，不内置在核心：理由同 ADR-0057 不内置钴蓝、洋红。`structure` 要有一个只用公开 API 写成的参考插件，否则第一个用它的就是第三方作者。站长要用高对比，内置也好、插件也好，都要在主题页上启用，多的只是先启用插件这一步。不另开一个插件：主题页本来就按"启用哪几套"管理，"更多配色"的名字和说明改成包括高对比就行。

### `packages/theme`

- 可改的颜色加上 `accent-fill`、`accent-fill-fg`，推导和两条新检查。
- 结构：三项的取值、钻石青的默认值、形状检查（未知的键、取值都拒绝，报给插件作者看），以及把补齐以后的结构交给生成 CSS。补齐以后的主题多一份完整的结构。
- 钻石青的结构默认值和 theme.css 一致，由测试守着，同颜色。

### CSS

theme.css 加上结构变量，名字在实现时定，下面是打算的样子：
- `--border-width-base: 1px`，并让 `--default-border-width` 指向它：`border`、`border-b`、`divide-y` 都跟着变；
- 选中框的粗细是 `--border-width-base` 的两倍，组件里的 `outline-2 -outline-offset-2` 改成读它；
- 卡片静止时的阴影 `--card-shadow`，没有阴影时是透明的零阴影 `0 0 #0000`，不写 `none`：它会被放进 `box-shadow` 的逗号列表，`none` 让整条声明失效，同一元素上的 ring 跟着消失。它不放进 `--shadow-*`：Tailwind 会把那里的值内联进工具类，主题改不了；组件写 `shadow-(--card-shadow)`（`packages/ui` 里允许任意值类）。
- 圆角沿用 `--radius-sm`、`--radius-md`。

`themeCss` 在 `[data-theme='<id>']` 那一块里写出全部结构变量（结构不分亮暗，暗色那一块不用重复）。钻石青的默认值也要写：小样嵌在别的主题的页面里时，不能从页面继承结构，和 ADR-0057 写出锁住的颜色是同一个原因。每套主题的 CSS 多大约 100 字节。

### 组件和页面

- **新组件 Panel**：页面上的面板，`rounded-md`、常规边框、`surface` 底，`cards: 'raised'` 时静止带阴影。页面里手拼的面板都换成它；嵌在面板里的框（只有边框、`bg` 或 `surface-sunken` 底）用它的另几种底色，不带静止阴影。虚线的空状态不是面板，统一用 `rounded-sm` 的虚线框（原来五处里只有一处是 `rounded-md`）。迁移以后 lint 在 `packages/ui` 以外禁止 `rounded-md`，页面不能再手拼面板，否则高对比下会漏掉阴影。配 story 和截图基线，DESIGN.md 组件清单补一行。
- **静止阴影**：Panel、TextureCard、PlayerCard、ThemeCard、ThemePicker 的选项，以及 Table 的外框。TexturePicker、PlayerPicker 的选项不带：它们悬停只露 2px 阴影，静止就带 4px，悬停反倒像按下去。
- **选中框**：TextureCard、TexturePicker、ThemeCard、ThemePicker、PlayerPicker 改读选中框的变量。
- **Tabs** 的指示条按边框变量对齐，不再写死 `-bottom-px`。
- **色块**：上面列出的几处改用 `accent-fill`、`accent-fill-fg`。
- **尺寸**：边框变粗以后，固定高度的控件里面少 2px，照旧放得下；材质卡片、角色卡的展台按材质像素定尺寸（DESIGN.md §5），边框不能把它挤小。这两点靠下面的截图把关。
- **ThemeCard** 的小样按比例画出结构（直角、粗边框、静止阴影），否则高对比在主题页上看起来只是黑白配色。

### Storybook 和截图

- Storybook 的工具栏加一项"结构"：钻石青，或者"全开"。全开是一套测试用的主题：钻石青的颜色加上三项结构，CSS 由 `packages/theme` 生成。用钻石青的颜色是为了只看结构；高对比的颜色在插件里，`packages/ui` 不依赖插件。
- `pnpm test:visual` 给每个 story 多拍一张：亮色加上结构全开。结构不分亮暗，暗色不再拍。基线从 308 张变成 462 张。
- 高对比的配色照旧不拍截图，靠检查把关（ADR-0057）。

### SDK

```ts
ui: {
  themes: [
    {
      name: 'high-contrast',
      label: 'themes.highContrast',
      structure: { radius: 'square', borders: 'thick', cards: 'raised' },
      colors: { /* … */ },
    },
  ],
}
```

- `ThemeContribution` 加可选的 `structure`，新类型 `ThemeStructure`；`ThemeColor` 加 `accent-fill`、`accent-fill-fg`。
- 不需要能力，安装前的确认照旧只列"提供 N 套主题"：结构也只是数据。
- 构建命令照原样把 `structure` 写进 manifest；plugin host 和安装时校验形状，不对的和别的 manifest 错误一样拒绝。
- type-tests 加上取值拼错的 `@ts-expect-error`；作者文档的主题一页加上结构和两个新颜色；附 changeset，作为 `1.0.0-rc.6` 发布。

### 测试

- `packages/theme`：两个新颜色的推导和检查；结构的形状检查、补齐和生成的 CSS；钻石青的结构和 theme.css 一致。
- SDK：type-tests；`ThemeColor` 和 theme.css 的颜色对得上（已有的测试照样守着）；api-extractor 报告。
- plugin host：`structure` 的校验。
- lint：禁止 `rounded-md` 的规则。
- 插件 `color-themes`：三套都通过完整检查。
- e2e：启用高对比、用户选它以后，面板的 `border-top-width` 是 2px、圆角是 0、带上 4px 的硬边阴影，主要按钮的底色是 `#d4ff1e`，亮色下链接是黑色、暗色下是荧光色；关掉以后回落照旧。
- 截图：每个 story 多一张结构全开的；Panel、ThemeCard 的新基线。

不加迁移，领域层的数据库测试不变。

### 落地顺序

一个 `feat/theme-structure` 分支，按顺序提交，做完再提 PR（ADR-0047：改了 SDK 公开 API）：

1. 这份 ADR；
2. token：theme.css 的两个新颜色和结构变量，`packages/theme` 的推导、检查、结构和生成 CSS，`pnpm design:sync`；
3. 组件：色块改用 `accent-fill`，结构变量、选中框、Tabs，Panel 和页面的迁移、lint，Storybook 的"结构"和新基线；
4. SDK、plugin host、构建命令、type-tests、作者文档、changeset；
5. 核心：注册表带上结构，ThemeCard 的小样，e2e；
6. "更多配色"加高对比；DESIGN.md §2.1、§2.3、§6、§11、§12 和附录，PROGRESS.md。

## 后果

- SDK 1.0 的公开面多了 `structure` 的三项枚举和两个颜色名。CSS 变量名没有公开，以后运行时组件开放时再决定公开哪些。
- `accent` 的意思窄了：新组件要分清画的是表面上的强调色还是色块。DESIGN.md §2.1 写明这条。
- 页面不能再手拼面板，只能用 Panel。
- 截图基线多 154 张，`pnpm test:visual` 大约慢一半。
- 每套主题的 CSS 多大约 100 字节。
- 卡片静止就带阴影的主题里，悬停的上移没那么显眼。
- DESIGN.md §2.3 的"页面结构不变"改成"只有圆角、边框粗细和卡片的静止阴影能变"。
- 主题还是改不了阴影的形状：Tailwind 4 把 `--shadow-*` 内联进工具类，要改得先让组件读变量。
- 站长要启用"更多配色"、再在主题页启用高对比，用户才选得到；不做这两步的站点没有高对比。

## 考虑过的其他方案

- **只给一个预设（`structure: 'default' | 'bold'`）**：组合最少，但只有高对比用得上，别的作者想要"只是直角"就做不了。三项各自独立，每项只改自己的变量，组合多了也不用逐一设计。
- **开放连续的取值（圆角 0–4px、边框 1–3px）**：要另写范围检查，冻住的东西更多，还会出现 3px 圆角这种不在 4px 网格上的值。枚举以后可以按需加。
- **公开 CSS 变量名，插件直接写值**：变量名就冻住了，检查不了，和"插件提供 CSS"差不多（ADR-0057 否决过）。
- **不拆强调色，高对比的 `accent` 直接用黑白**：荧光色就没了，高对比只剩黑白；亮色白底和暗色黑底对荧光色的要求不同，按模式取值的颜色 token 正好能表达，开关做不到。
- **拆出"强调色文字"（`accent-text`），`accent` 留给色块**：要改四十来处，还要把原有的 `accent` 对 `bg`、`surface` 两组检查挪到新颜色上。拆色块只改几处，原有检查不动。
- **用一个开关表示"链接和选中态用正文色"**：开关不分亮暗，高对比暗色下的荧光色本来就看得清；颜色 token 按模式取值，更直接。
- **高对比内置在核心**：结构字段就没有参考插件；站长照样要在主题页启用，省掉的只是启用插件这一步。
- **高对比单独做一个官方插件**：多打包、多测一个插件，换来的只是插件列表里多一个名字。主题页本来就按套启用。
- **截图拍高对比本身的配色**：`packages/ui` 要依赖插件才拿得到取值；配色由检查把关，截图只看结构。
- **每个 story 只在部分组件上拍结构**：结构改动几乎碰到每个组件，挑哪些要靠猜，漏掉的正是没想到的那些。
- **结构做成用户的独立偏好（像亮暗那样）**：多一个和主题组合的维度，每套主题都要和两种结构配得上；高对比的颜色和结构是一起设计的。以后真有人只要粗边框，再按 `prefers-contrast` 一起议。
