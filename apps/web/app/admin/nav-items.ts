import { Bell } from 'pixelarticons/react/Bell.js'
import { Chart } from 'pixelarticons/react/Chart.js'
import { Code } from 'pixelarticons/react/Code.js'
import { Database } from 'pixelarticons/react/Database.js'
import { Flag } from 'pixelarticons/react/Flag.js'
import { Gamepad } from 'pixelarticons/react/Gamepad.js'
import { Notebook } from 'pixelarticons/react/Notebook.js'
import { Plug } from 'pixelarticons/react/Plug.js'
import { Sliders } from 'pixelarticons/react/Sliders.js'
import { Users } from 'pixelarticons/react/Users.js'
import { WarningDiamond } from 'pixelarticons/react/WarningDiamond.js'

// 布局（服务端，按权限过滤）和导航（客户端，渲染图标）共用，不能放在 'use client' 的文件里

/**
 * 后台的导航项，由核心登记在这里，按查看者的权限过滤（ADR-0027）。插件声明的 `area: 'admin'` 导航项
 * 由布局另外取来，排在这些后面（ADR-0033）。label 是 admin.nav 下的文案键
 */
export const adminNavItems = [
  { href: '/admin', icon: Chart, label: 'overview', permission: null },
  { href: '/admin/reports', icon: Flag, label: 'reports', permission: 'reports.review' },
  { href: '/admin/users', icon: Users, label: 'users', permission: 'users.ban' },
  { href: '/admin/players', icon: Gamepad, label: 'players', permission: 'players.manage' },
  { href: '/admin/oauth-clients', icon: Code, label: 'oauthClients', permission: 'oauthClients.manage' },
  { href: '/admin/notifications', icon: Bell, label: 'notifications', permission: 'notifications.send' },
  { href: '/admin/audit', icon: Notebook, label: 'audit', permission: 'audit.read' },
  { href: '/admin/settings', icon: Sliders, label: 'settings', permission: 'settings.manage' },
  { href: '/admin/plugins', icon: Plug, label: 'plugins', permission: 'plugins.manage' },
  { href: '/admin/failed-jobs', icon: WarningDiamond, label: 'failedJobs', permission: 'jobs.manage' },
  { href: '/admin/migration', icon: Database, label: 'migration', permission: 'import.manage' },
] as const

export type AdminNavHref = (typeof adminNavItems)[number]['href']
