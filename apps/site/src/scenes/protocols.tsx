import { barsFrom, enter, SIXTEENTH, useT } from '../stage/time.ts'
import { abs, Panel, Px, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(10)

// 四种协议绕成一圈，顺时针排
const nodes = [
  { name: 'CSL', sub: 'CustomSkinLoader', x: 560, y: 300 },
  { name: 'USM', sub: 'UniSkinMod', x: 1080, y: 300 },
  { name: 'Yggdrasil', sub: 'authlib-injector', x: 1080, y: 580 },
  { name: 'Legacy', sub: '旧版地址 legacy URLs', x: 560, y: 580 },
] as const

/** 四种协议依次接通，连成一圈。和 BS 一样的协议，所以模组和启动器不用升级 */
function Protocols() {
  const t = useT()
  const lit = nodes.filter((_, i) => t >= at(10, 1 + i)).length

  return (
    <Scene>
      <Title zh="和 Blessing Skin 同一套协议" en="Same protocols as Blessing Skin" />
      <svg aria-hidden className="absolute" style={{ left: 0, top: 0 }} width={1280} height={720}>
        {nodes.map((n, i) => {
          const next = nodes[(i + 1) % 4]!
          // 两头都接通了，这一段才变成实线
          const on = i + 1 < lit || (i === 3 && lit === 4)
          return (
            <line
              key={n.name}
              x1={n.x}
              y1={n.y}
              x2={next.x}
              y2={next.y}
              className={on ? 'stroke-accent' : 'stroke-border'}
              strokeWidth={on ? 6 : 4}
              strokeDasharray={on ? undefined : '8 8'}
              shapeRendering="crispEdges"
            />
          )
        })}
      </svg>
      {nodes.map((n, i) => {
        const on = i < lit
        return (
          <div key={n.name} style={abs(n.x - 120, n.y - 44, { width: 240 })}>
            <Panel
              shadow={on ? 4 : 2}
              bg={on ? 'accent-subtle' : 'surface'}
              edge={on ? 'accent' : 'border'}
              thick={on}
              style={{ padding: '12px 16px', textAlign: 'center' }}
            >
              <Px size={36}>{n.name}</Px>
              <Px size={12} tone="muted">
                {n.sub}
              </Px>
            </Panel>
          </div>
        )
      })}
      <div style={abs(540, 400, { width: 560, textAlign: 'center', ...enter(t, at(11)) })}>
        <Px size={36}>模组和启动器不用升级</Px>
        <Px size={24} tone="muted" style={{ marginTop: 8 }}>
          Mods &amp; launchers keep working
        </Px>
      </div>
      <div style={abs(64, 260, { width: 400, ...enter(t, at(10, 3)) })}>
        <Px size={24}>路径、状态码、响应头、响应结构</Px>
        <Px size={24} tone="accent">
          都和 BS v6 一致
        </Px>
        <Px size={12} tone="muted" style={{ marginTop: 8 }}>
          PATHS, STATUS CODES, HEADERS, BODIES — SAME AS BS v6
        </Px>
      </div>
      <div style={abs(64, 420, { width: 400, ...enter(t, at(11, 2)) })}>
        <Px size={24}>玩家 UUID 永不改变</Px>
        <Px size={12} tone="muted" style={{ marginTop: 4 }}>
          PLAYER UUIDS NEVER CHANGE
        </Px>
      </div>
    </Scene>
  )
}

export const protocols: Page = {
  id: 'protocols',
  Scene: Protocols,
  duration: at(11, 2) + SIXTEENTH,
  hold: 4,
  chapter: { no: '02', zh: '兼容', en: 'COMPATIBLE' },
  text: {
    title: '和 Blessing Skin 同一套协议',
    en: 'Same protocols as Blessing Skin',
    body: [
      'CustomSkinLoader、UniSkinMod、旧版材质地址和 Yggdrasil（authlib-injector）四种协议，路径、状态码、响应头和响应结构都和 Blessing Skin v6 一致。玩家的模组和启动器不用改配置，也不用升级。',
      '玩家 UUID 创建以后永不改变，从旧站导入时原样保留：游戏服务器按 UUID 存背包和权限，换了就全对不上。',
    ],
  },
}
