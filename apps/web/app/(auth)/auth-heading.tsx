import type { ReactNode } from 'react'

/** 认证页的标题：像素字体，下面一行是去往其他认证页的提示 */
export function AuthHeading({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-2">
      <h1 className="font-pixel text-pixel-2 text-text">{title}</h1>
      {/* 同意页在这里写当前用户的昵称，最长 255 个字符，可以在任意位置折行 */}
      {children && <p className="text-sm wrap-anywhere text-text-muted">{children}</p>}
    </div>
  )
}
