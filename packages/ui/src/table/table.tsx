import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface TableColumn<Key extends string> {
  key: Key
  /** 表头，像素字体的固定文案，例如“UID”“操作” */
  header: string
  /** 数字列靠右对齐，并用等宽数字（DESIGN.md §4） */
  align?: 'start' | 'end'
  /** 只占内容的宽度、不换行，例如 UID、时间、操作。其余的列平分剩下的宽度 */
  shrink?: boolean
}

export interface TableRow<Key extends string> {
  key: string | number
  cells: Readonly<Record<Key, ReactNode>>
}

export interface TableProps<Key extends string> {
  /** 表格的名称，例如“待处理的举报”。读屏软件读它，也是横向滚动区域的名称 */
  label: string
  columns: readonly TableColumn<Key>[]
  rows: readonly TableRow<Key>[]
  /** 没有行时，表格里显示的一句话，例如“没有待处理的举报” */
  empty: ReactNode
}

/**
 * 后台的数据列表。信息密集（DESIGN.md 原则 5）：14px 正文，行高 40px，放得下 32px 的按钮；
 * 表头用像素字体，下沿是 border-strong；悬停的行用 surface-sunken 作底，方便横着看一行。
 * 窄屏放不下时在表格自己的容器里横向滚动，页面不跟着滚；容器能用键盘聚焦，方向键可以滚动
 */
export function Table<Key extends string>({ label, columns, rows, empty }: TableProps<Key>) {
  return (
    <div
      role="region"
      aria-label={label}
      // 可滚动的区域要能聚焦，键盘用户才滚得动
      tabIndex={0}
      className={cx('overflow-x-auto rounded-md border border-border bg-surface', focusRing)}
    >
      <table className="w-full border-collapse text-left text-sm text-text">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-border-strong">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  'h-8 px-3 font-pixel text-pixel-1 font-normal whitespace-nowrap text-text-muted',
                  column.align === 'end' && 'text-right',
                  column.shrink && 'w-px',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length > 0 ? (
            rows.map((row) => (
              <tr key={row.key} className="border-b border-border last:border-b-0 hover:bg-surface-sunken">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(
                      'h-10 px-3 py-1 align-middle',
                      column.align === 'end' && 'text-right tabular-nums',
                      column.shrink && 'w-px whitespace-nowrap',
                    )}
                  >
                    {row.cells[column.key]}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-text-muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
