import type { HeadElement } from '@nextskin/domain'
import type { HTMLAttributeReferrerPolicy } from 'react'
import { sessionChangeScript } from '../lib/session-change'

/**
 * 页头代码（ADR-0063）：保存时检查过、渲染时再解析出的 <meta> 和 <script>，按原来的顺序放进 <head>。
 * 每个脚本带本次请求的 nonce（ADR-0053），由它们再加载的脚本由 'strict-dynamic' 放行。
 * 内联的代码原样输出：解析时已经截在 </script> 之前，拼不出别的标签。
 * 最前面是核心自己的脚本：别的标签页登录以后整页重新加载（lib/session-change.ts）
 */
export function CustomHead({ elements, nonce }: { elements: readonly HeadElement[]; nonce: string | undefined }) {
  if (!elements.length) return null
  return [
    <script key="session-change" nonce={nonce} dangerouslySetInnerHTML={{ __html: sessionChangeScript }} />,
    ...elements.map((element, index) => {
      if (element.kind === 'meta')
        return <meta key={index} name={element.name} property={element.property} content={element.content} />
      const { src, async, defer, type, crossorigin, referrerpolicy, integrity, charset, id, data } = element.attributes
      return (
        <script
          key={index}
          nonce={nonce}
          src={src}
          async={async}
          defer={defer}
          type={type}
          crossOrigin={crossorigin as '' | 'anonymous' | 'use-credentials' | undefined}
          referrerPolicy={referrerpolicy as HTMLAttributeReferrerPolicy | undefined}
          integrity={integrity}
          charSet={charset}
          id={id}
          {...data}
          {...(element.code ? { dangerouslySetInnerHTML: { __html: element.code } } : {})}
        />
      )
    }),
  ]
}
