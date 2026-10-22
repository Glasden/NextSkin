import { cx } from '@nextskin/ui'
import repoData from '../gen/repo-data.json'
import { barsFrom, enter, SIXTEENTH, useT } from '../stage/time.ts'
import { abs, Prompt, Px, Scene, Terminal, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(39)

// nextskin doctor 的输出格式（packages/launcher/src/commands/doctor.ts）：[通过] 检查项：说明
const checks = [
  ['Node', '26.12.0；插件不能直接连网'],
  ['配置文件', '.env；存在'],
  ['密钥', '来源：.env；长度符合要求'],
  ['数据目录', 'data；可写，剩余 112.4 GB'],
  ['数据库', `SQLite；全部 ${repoData.migrations} 个迁移已执行`],
  ['plugin host', '已带 --permission 启动并完成握手、退出'],
  ['服务', '服务在运行，/api/health 响应正常'],
] as const

const PASSED = at(40, 4)

/** nextskin doctor 一项一项检查运行环境，最后全部通过 */
function Doctor() {
  const t = useT()
  const shown = checks.filter((_, i) => t >= at(39, 1 + i)).length
  const passed = t >= PASSED
  return (
    <Scene>
      <Title zh="出了问题，先问 doctor" en="When something's off, ask the doctor" />
      <div style={abs(64, 214, { width: 1152 })}>
        <Terminal style={{ height: 380, padding: '24px 36px' }}>
          <Prompt size={24}>node nextskin.mjs doctor</Prompt>
          <div style={{ marginTop: 12 }}>
            {checks.slice(0, shown).map(([item, message]) => (
              <div key={item} className="flex whitespace-pre" style={{ fontSize: 22, lineHeight: '42px', gap: 16 }}>
                <span className="text-success">[通过]</span>
                <span className="font-bold text-text">{item}</span>
                <span className="text-text-muted">{message}</span>
              </div>
            ))}
          </div>
        </Terminal>
      </div>
      <div className="flex items-baseline" style={abs(64, 616, { gap: 24, ...enter(t, PASSED) })}>
        <div className={cx('shadow-pixel-lg', passed && 'bg-success')} style={{ padding: '0 16px' }}>
          <Px size={36} tone="success-fg">
            全部通过
          </Px>
        </div>
        <Px size={24}>只读地检查，有失败时退出码 1</Px>
      </div>
    </Scene>
  )
}

export const doctor: Page = {
  id: 'doctor',
  Scene: Doctor,
  duration: PASSED + SIXTEENTH,
  hold: 3,
  chapter: { no: '04', zh: '自检', en: 'DOCTOR' },
  text: {
    title: '出了问题，先问 doctor',
    en: "When something's off, ask the doctor",
    body: [
      '`node nextskin.mjs doctor` 只读地检查运行环境：Node 版本、配置文件、密钥、数据目录、数据库连接和迁移状态、插件进程能不能带权限模型启动、服务在不在运行。有失败时退出码是 1，适合放进部署脚本。',
      '忘了超级管理员的密码、两步验证丢了、验证码把自己挡在外面，也都有对应的命令。',
    ],
  },
}
