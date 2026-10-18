import { Chart } from 'pixelarticons/react/Chart.js'
import { Flag } from 'pixelarticons/react/Flag.js'
import { Notebook } from 'pixelarticons/react/Notebook.js'
import { Users } from 'pixelarticons/react/Users.js'

// 布局（服务端，按权限过滤）和导航（客户端，渲染图标）共用，不能放在 'use client' 的文件里

/**
 * 后台的导航项，由核心登记在这里，按查看者的权限过滤（ADR-0027）。插件运行时落地后，
 * 再合并插件声明的 `area: 'admin'` 导航项（ADR-0011）。label 是 admin.nav 下的文案键
 */
export const adminNavItems = [
  { href: '/admin', icon: Chart, label: 'overview', permission: null },
  { href: '/admin/reports', icon: Flag, label: 'reports', permission: 'reports.review' },
  { href: '/admin/users', icon: Users, label: 'users', permission: 'users.ban' },
  { href: '/admin/audit', icon: Notebook, label: 'audit', permission: 'audit.read' },
] as const

export type AdminNavHref = (typeof adminNavItems)[number]['href']
