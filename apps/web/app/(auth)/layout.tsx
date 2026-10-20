import type { ReactNode } from 'react'
import { AuthShell } from './auth-shell'

/** 登录、注册、找回密码共用：左边是表单，右边是展台上的皮肤 */
export default function AuthLayout({ children }: { readonly children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>
}
