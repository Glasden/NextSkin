# 配色主题

`ui.themes` 声明的是数据，不是 CSS：插件只写要改的颜色，核心补齐、检查后生成样式。不需要能力，也不能通过主题交付脚本、字体、圆角、动效或页面结构。

```ts
import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  ui: {
    themes: [
      {
        name: 'cobalt',
        label: 'themes.cobalt',
        colors: {
          light: { accent: '#2a52e5' },
          dark: { accent: '#86a2ff' },
        },
      },
    ],
  },
})
```

`label` 是插件自己的文案键，在 `locales/zh-CN.json` 和 `locales/en.json` 中分别写入名字，例如 `{ "themes": { "cobalt": "钴蓝" } }`。官方插件 [color-themes](https://github.com/Glasden/NextSkin/tree/main/plugins/color-themes) 是完整例子。

主题 id 为 `<插件 id>/<name>`，例如 `color-themes/cobalt`。`name` 匹配 `[a-z][a-z0-9]*(-[a-z0-9]+)*`，最多 32 个字符，同一插件内不能重复；一个插件最多声明 16 套。

## 能改哪些颜色

`ThemeColor` 是以下 20 个 token 名的联合，不带 `--color-` 前缀。这些名字是公开 API，改名或删除要发大版本。

| token | 用途 |
|---|---|
| `bg` | 页面背景 |
| `surface` | 卡片、面板背景 |
| `surface-raised` | 浮起的表面 |
| `surface-sunken` | 下沉的表面 |
| `border` | 普通边框 |
| `border-strong` | 强调边框 |
| `text` | 正文 |
| `text-muted` | 次要文字 |
| `text-inverse` | 反色文字 |
| `accent` | 强调色 |
| `accent-fg` | 强调色上的前景 |
| `accent-subtle` | 强调色淡底 |
| `success` | 成功色 |
| `success-fg` | 成功色上的前景 |
| `warning` | 警告色 |
| `warning-fg` | 警告色上的前景 |
| `danger` | 危险色 |
| `danger-fg` | 危险色上的前景 |
| `focus` | 焦点框 |
| `shadow` | 阴影 |

`stage`（材质展台）、`checker-a`、`checker-b`（透明区域的棋盘格）锁住，在任何主题下都取钻石青的默认值，保证深色、浅色材质都看得清。

`colors.light`、`colors.dark` 都可以省略，也都可以只写一部分。色值只接受 `#rrggbb`，不分大小写，manifest 中统一存成小写；三位、八位、颜色函数或带空白的写法都不接受。SDK 的 `ThemeColorValue` 类型只检查 `#` 开头，完整格式由构建命令检查。

## 只写要改的

没有声明的颜色按模式补齐：

- `focus` 等于本主题的 `accent`；
- `accent-subtle` 是本主题的 `accent` 按 12%（亮色）或 16%（暗色）在 sRGB 中混入本主题的 `surface`，各通道四舍五入；
- 其余取钻石青的默认值。

上例只改 `accent`，推导出的淡底就是亮色 `#e5eafc`、暗色 `#282f41`。需要别的焦点框或淡底时可以显式声明。不要抄一整份默认配色：核心以后微调灰色时，省略的值会跟着更新。

## 检查规则

检查针对补齐后的完整配色，两种模式分别检查以下三条。

1. **对比度**：正文相关组合至少 4.5:1，边框和焦点框至少 3:1。下表同一行有多个背景时，每个都单独检查，共 25 组。

   | 前景 | 背景 | 最低比值 |
   |---|---|---|
   | `text` | `bg`、`surface`、`surface-raised`、`stage`、`accent-subtle` | 4.5 |
   | `text-muted` | `bg`、`surface`、`surface-raised`、`surface-sunken`、`stage`、`accent-subtle` | 4.5 |
   | `text-inverse` | `text` | 4.5 |
   | `accent-fg` | `accent` | 4.5 |
   | `accent` | `bg`、`surface` | 4.5 |
   | `success-fg` | `success` | 4.5 |
   | `success` | `surface` | 4.5 |
   | `warning-fg` | `warning` | 4.5 |
   | `warning` | `surface` | 4.5 |
   | `danger-fg` | `danger` | 4.5 |
   | `danger` | `surface` | 4.5 |
   | `border-strong` | `surface`、`bg` | 3 |
   | `focus` | `bg`、`surface` | 3 |

2. **明暗方向**：亮色模式下 `bg`、`text-inverse` 的相对亮度都必须大于 `text`；暗色模式下都必须小于 `text`，使浏览器原生控件和二维码的明暗方向一致。
3. **强调色和危险色分开**：`accent` 和 `danger` 的 OKLab 欧氏距离至少为 0.12。主要按钮和删除按钮不能看着一样。其他状态色之间不检查距离，仍建议肉眼核对。

`nextskin-plugin build` 会检查形状和这三条规则；不通过就构建失败，逐条列出主题名、亮暗模式、哪一组和实际值。洋红强调色配默认危险色的距离只有约 0.10，需要调整危险色；调整以后也要注意它是否与警告色太接近。

核心不信任构建工具：安装、升级插件时用核心自己的默认值再检查，不通过就拒绝安装。核心升级后每次加载插件也检查；某套主题不再通过时，只禁用这一套，后台主题页列出原因，插件的其他功能照常。

## 站长和用户怎样启用

插件新带来的主题默认不启用。超级管理员先在后台的主题页查看小样，再启用需要的主题、设置站点默认主题；安装或启用插件不会自动把它的主题开放给用户。

登录用户在用户中心的主题页选择已启用的主题，也可以跟随站点默认。选择存在账号里，换设备仍然生效；亮暗模式独立按设备保存。访客看站点默认主题。

用户所选主题暂时不可用时，回落到站点默认，再回落到钻石青；插件恢复、主题重新可用后，原来的选择继续生效。
