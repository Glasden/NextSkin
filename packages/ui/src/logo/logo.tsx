'use client'

import { useRender } from '@base-ui/react/use-render'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'
import { LogoMark } from './logo-mark.tsx'
import { LOGO_MARK_SIZE } from './mark.ts'

export interface LogoProps {
  /** 站点名，取自站点设置 */
  name: string
  /** 每格 3px（后台侧栏、页脚）或 4px（页头） */
  size?: 'sm' | 'md'
  /**
   * 站长上传的站点标志（ADR-0042）：替换像素图形，尺寸不变，站点名照旧写在旁边。
   * 上传的图多数不是像素画，按浏览器默认的平滑缩放显示
   */
  image?: string
  /**
   * 页头的标志一般链接到首页：传框架的链接组件，例如 `render={<NextLink href="/" />}`。
   * 链接不加下划线，键盘聚焦时显示焦点框
   */
  render?: useRender.RenderProp
}

const sizes = {
  sm: { cell: 3, name: 'text-pixel-1', gap: 'gap-2' },
  md: { cell: 4, name: 'text-pixel-2', gap: 'gap-3' },
}

/**
 * 标志：折起来的头，前脸用强调色（DESIGN.md §2.2）。图形按整数倍放大，像素锐利；
 * favicon 由同一份图形生成（scripts/design-sync.ts）。站长上传了标志时换成那张图
 */
export function Logo({ name, size = 'md', render, image }: LogoProps) {
  const style = sizes[size]
  const px = LOGO_MARK_SIZE * style.cell
  return useRender({
    defaultTagName: 'span',
    render,
    props: {
      className: cx('inline-flex items-center', style.gap, render && cx('rounded-sm', focusRing)),
      children: (
        <>
          {image ? (
            // 不经过 next/image（不变量 8）；旁边写着站点名，图片本身不用读出来
            <img src={image} alt="" width={px} height={px} className="block shrink-0" />
          ) : (
            <LogoMark cell={style.cell} />
          )}
          <span className={cx('font-pixel text-text', style.name)}>{name}</span>
        </>
      ),
    },
  })
}
