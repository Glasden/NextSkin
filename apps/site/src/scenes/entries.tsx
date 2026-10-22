import { ButtonLink } from '@nextskin/ui'
import type { CSSProperties } from 'react'
import { links } from '../links.ts'

/** 首屏和尾页的三个入口（ADR-0055） */
export function Entries({ style }: { style?: CSSProperties }) {
  return (
    <div className="flex" style={{ gap: 16, ...style }}>
      <ButtonLink variant="primary" size="lg" href={links.docs}>
        阅读文档
      </ButtonLink>
      <ButtonLink size="lg" href={links.instance}>
        看一个在用的站点
      </ButtonLink>
      <ButtonLink size="lg" href={links.github}>
        GitHub
      </ButtonLink>
    </div>
  )
}
