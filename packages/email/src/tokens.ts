// 邮件客户端不支持 CSS 变量，颜色写成具体的值：取 packages/ui/src/theme.css 的亮色取值，只用亮色。
// tokens.test.ts 核对它们和 theme.css 一致，改 token 时测试会提醒同步这里。
export const colors = {
  bg: '#f2f3f5',
  surface: '#ffffff',
  border: '#d5d8de',
  'border-strong': '#3d434c',
  text: '#14171c',
  'text-muted': '#5a616c',
  accent: '#08736b',
  'accent-fg': '#ffffff',
  shadow: '#1d2127',
} as const

export const fontSans = "-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
