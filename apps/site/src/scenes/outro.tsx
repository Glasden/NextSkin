import repoData from '../gen/repo-data.json'
import { LogoCells } from '../stage/skin.tsx'
import { barsFrom, enter, SIXTEENTH, useT } from '../stage/time.ts'
import { Center, Px } from '../stage/ui.tsx'
import { Entries } from './entries.tsx'
import type { Page } from './page.ts'

const at = barsFrom(41)

const stats = [
  [String(repoData.adrs), '份架构决策', 'ADRS'],
  [String(repoData.contractTitles.length), '条契约回放', 'CONTRACT CASES'],
  ['4', '种数据库', 'DATABASES'],
  ['0', '个原生依赖', 'NATIVE DEPS'],
] as const

/** 尾页：落版，四个数字一个一个出来，再给出三个入口 */
function Outro() {
  const t = useT()
  return (
    <>
      <Center>
        <div className="flex items-center" style={{ gap: 32 }}>
          <LogoCells cell={12} />
          <Px size={96}>NextSkin</Px>
        </div>
        <Px size={36} style={{ marginTop: 24 }}>
          Minecraft 皮肤站，重新出发
        </Px>
        <Px size={24} tone="muted" style={{ marginTop: 8 }}>
          Blessing Skin, rebuilt from the ground up
        </Px>
        <div className="flex" style={{ gap: 48, marginTop: 36 }}>
          {stats.map(([n, zh, en], i) => (
            <div key={en} style={{ textAlign: 'center', ...enter(t, at(41, 1 + i)) }}>
              <Px size={48} tone="accent">
                {n}
              </Px>
              <Px size={24}>{zh}</Px>
              <Px size={12} tone="muted">
                {en}
              </Px>
            </div>
          ))}
        </div>
        <Entries style={{ marginTop: 40, ...enter(t, at(42)) }} />
      </Center>
      <div style={{ position: 'absolute', right: 64, bottom: 40, textAlign: 'right' }}>
        <Px size={12} tone="muted">
          展示皮肤 · cxchency
        </Px>
      </div>
    </>
  )
}

export const outro: Page = {
  id: 'start',
  Scene: Outro,
  duration: at(42) + SIXTEENTH,
  text: {
    title: 'Minecraft 皮肤站，重新出发',
    en: 'Blessing Skin, rebuilt from the ground up',
    body: [
      `${repoData.adrs} 份架构决策记录，${repoData.contractTitles.length} 条对照 BS v6 的契约回放，SQLite、MySQL / MariaDB、PostgreSQL 四种数据库，0 个原生依赖。`,
      '从文档开始搭一个，或者先去一个在用的站点看看。展示用的皮肤由 cxchency 提供。',
    ],
  },
}
