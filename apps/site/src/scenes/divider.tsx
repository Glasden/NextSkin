import { barsFrom, enter, SIXTEENTH, useT } from '../stage/time.ts'
import { Center, Px } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(32)

/** 分界：前半是服主和玩家看得见的部分，后半讲看不见的部分 */
function Divider() {
  const t = useT()
  return (
    <Center gap={56}>
      <div style={{ textAlign: 'center' }}>
        <Px size={48}>以上是看得见的部分</Px>
        <Px size={24} tone="muted" style={{ marginTop: 8 }}>
          That&apos;s the part you can see.
        </Px>
      </div>
      <div style={{ textAlign: 'center', ...enter(t, at(32, 3)) }}>
        <Px size={60} tone="accent">
          接下来，是看不见的部分
        </Px>
        <Px size={24} tone="muted" style={{ marginTop: 8 }}>
          Now, what&apos;s underneath.
        </Px>
      </div>
    </Center>
  )
}

export const divider: Page = {
  id: 'underneath',
  Scene: Divider,
  duration: at(32, 3) + SIXTEENTH,
  hold: 2,
  text: {
    title: '接下来，是看不见的部分',
    en: "Now, what's underneath.",
    body: [
      '上面是服主和玩家看得见的部分。下面几页讲 NextSkin 在底下下的功夫：材质怎么存、上传怎么查、协议怎么守、皮肤图怎么画、插件怎么隔离、后台任务怎么不丢。',
    ],
  },
}
