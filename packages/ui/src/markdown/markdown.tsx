import type { ComponentPropsWithoutRef, ElementType } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'
import { CopyableCodeBlock, type MarkdownCopyLabels } from './code-block.tsx'

export interface MarkdownProps {
  /** GitHub 风格的 Markdown。原始 HTML 直接去掉，不渲染（ADR-0028） */
  children: string
  /** 所在区块标题的级别：Markdown 的 `#` 从下一级开始。默认 2，`#` 渲染成 h3 */
  headingLevel?: 1 | 2 | 3 | 4 | 5
  /**
   * 页脚这类只有一两行字的地方：图片缩到一行字的高度，和文字排在同一行，不加圆角。
   * 例如备案号前面的公安备案图标（ADR-0042）
   */
  inlineImages?: boolean
  /**
   * 给了就在每个代码块右上角放复制按钮，复制整块的文字，例如插件页上要用户发给机器人的一条命令。
   * 结果用 Toast 告诉用户，要放在 ToastProvider 里面
   */
  copy?: MarkdownCopyLabels
}

const linkProtocols = /^(?:https?|mailto)$/i
const imageProtocols = /^https?$/i

/**
 * 链接只放行 http、https、mailto 和站内路径，图片只放行 http、https 和站内路径。
 * 判断方式同 react-markdown 的 defaultUrlTransform：冒号出现在 / ? # 之前才算带了协议
 */
export function markdownUrl(url: string, key: string): string {
  const colon = url.indexOf(':')
  const slash = url.indexOf('/')
  const question = url.indexOf('?')
  const hash = url.indexOf('#')
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash)
  )
    return url
  return (key === 'src' ? imageProtocols : linkProtocols).test(url.slice(0, colon)) ? url : ''
}

const headingClass = ['text-lg font-semibold', 'text-base font-semibold', 'text-base font-medium']
const cellClass = 'border-b border-border px-3 py-2 text-left align-top'
const codeBlockClass = 'font-mono text-sm [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-sm'

/** react-markdown 会把 hast 节点作为 node 传给组件，不能落到 DOM 上 */
function omitNode<P extends { node?: unknown }>(props: P): Omit<P, 'node'> {
  const copy: Partial<P> = { ...props }
  delete copy.node
  return copy as Omit<P, 'node'>
}

function heading(depth: number, level: number) {
  const Tag = `h${Math.min(depth + level, 6)}` as ElementType
  return function Heading(props: ComponentPropsWithoutRef<'h1'> & { node?: unknown }) {
    return <Tag {...omitNode(props)} className={cx('text-pretty text-text', headingClass[Math.min(depth - 1, 2)])} />
  }
}

function components(level: number, inlineImages: boolean, copy: MarkdownCopyLabels | undefined): Components {
  return {
    h1: heading(1, level),
    h2: heading(2, level),
    h3: heading(3, level),
    h4: heading(4, level),
    h5: heading(5, level),
    h6: heading(6, level),
    p: (props) => <p {...omitNode(props)} className="text-pretty" />,
    // 地址被 markdownUrl 清空的链接只留文字
    a: (props) =>
      props.href ? (
        <a
          {...omitNode(props)}
          className={cx(
            'rounded-sm text-accent underline decoration-1 underline-offset-4 hover:decoration-2',
            focusRing,
          )}
        />
      ) : (
        <span>{props.children}</span>
      ),
    // 任务列表不要圆点，复选框就是标记
    ul: (props) => (
      <ul
        {...omitNode(props)}
        className={cx('flex flex-col gap-1', props.className === 'contains-task-list' ? 'pl-1' : 'list-disc pl-6')}
      />
    ),
    ol: (props) => <ol {...omitNode(props)} className="flex list-decimal flex-col gap-1 pl-6" />,
    li: (props) => <li {...omitNode(props)} className="pl-1 [&>ol]:mt-1 [&>ul]:mt-1" />,
    input: (props) => <input {...omitNode(props)} className="mr-2 align-middle accent-accent" />,
    blockquote: (props) => (
      <blockquote
        {...omitNode(props)}
        className="flex flex-col gap-3 border-l-4 border-border-strong pl-4 text-text-muted"
      />
    ),
    code: (props) => (
      <code {...omitNode(props)} className="rounded-sm bg-surface-sunken px-1 py-0.5 font-mono text-[0.875em]" />
    ),
    // 代码块和表格在自己的容器里横向滚动，页面本身不横向滚动
    pre: copy
      ? (props) => <CopyableCodeBlock {...omitNode(props)} copy={copy} className={codeBlockClass} />
      : (props) => (
          <pre
            {...omitNode(props)}
            className={cx('overflow-x-auto rounded-sm bg-surface-sunken p-3', codeBlockClass)}
          />
        ),
    table: (props) => (
      <div className="overflow-x-auto">
        <table {...omitNode(props)} className="min-w-full border-collapse text-sm tabular-nums" />
      </div>
    ),
    th: (props) => (
      <th {...omitNode(props)} className={cx(cellClass, 'border-border-strong font-medium whitespace-nowrap')} />
    ),
    td: (props) => <td {...omitNode(props)} className={cellClass} />,
    hr: (props) => <hr {...omitNode(props)} className="border-border" />,
    // 图片不经过 next/image（不变量 8）。一行高的图片顶端对齐行框，正好占满一行，不把行撑高
    img: (props) =>
      props.src ? (
        <img
          {...omitNode(props)}
          alt={props.alt ?? ''}
          loading="lazy"
          className={inlineImages ? 'inline h-[1lh] w-auto max-w-full align-top' : 'h-auto max-w-full rounded-sm'}
        />
      ) : null,
    del: (props) => <del {...omitNode(props)} className="text-text-muted" />,
  }
}

const cache = new Map<string, Components>()

/**
 * 管理员写的长文，例如公告和内容政策。块之间间距 16px，字号随所在的容器；
 * 链接、图片按 markdownUrl 过滤，原始 HTML 去掉。用户产生的内容（材质描述）不用它，按纯文本显示（ADR-0025）
 */
export function Markdown({ children, headingLevel = 2, inlineImages = false, copy }: MarkdownProps) {
  const key = JSON.stringify([headingLevel, inlineImages, copy && [copy.label, copy.done, copy.failed]])
  let mapped = cache.get(key)
  if (!mapped) cache.set(key, (mapped = components(headingLevel, inlineImages, copy)))
  return (
    <div className="flex min-w-0 flex-col gap-4 break-words text-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={markdownUrl} components={mapped}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
