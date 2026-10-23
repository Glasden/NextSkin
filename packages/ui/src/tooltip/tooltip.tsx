'use client'

import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

export interface TooltipProps {
  /** 简短的补充说明，例如图标按钮的名称。不放必须读到的内容：触屏设备上不显示 */
  content: ReactNode
  /** 触发元素，一般是 IconButton 里的按钮 */
  children: ReactElement
}

/** 鼠标停留或键盘聚焦时显示的提示，深色底、浅色字（与名牌相同的配色） */
export function Tooltip({ content, children }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner className="z-50" sideOffset={8} collisionPadding={8}>
          <BaseTooltip.Popup
            className={
              // 渲染在 body 下，字体自己设。出现和消失是四格阶跃的淡入淡出
              'rounded-sm bg-text px-2 py-1 font-sans text-xs text-text-inverse transition-opacity duration-fast ease-step motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0'
            }
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
