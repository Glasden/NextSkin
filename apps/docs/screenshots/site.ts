// 截图前写进站点设置（ADR-0060）：站名、一条公告、邮件的发件地址（不然后台概览顶上是"还有配置没完成"）。
// 在服务启动之前直接写设置表，不经后台：经后台改会记进审计日志，出现在后台概览的截图里。
//   NEXTSKIN_SECRET=… node screenshots/site.ts <数据目录>
import { join, resolve } from 'node:path'
import { createDatabase, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import { encodeSettingValue } from '@nextskin/domain'

const [directory] = process.argv.slice(2)
const secretKey = process.env.NEXTSKIN_SECRET
if (!directory || !secretKey) throw new Error('用法：NEXTSKIN_SECRET=… node screenshots/site.ts <数据目录>')

const values = [
  encode('site.name', 'NextSkin 演示站'),
  encode('site.announcement', '**维护通知**：本周六 02:00 到 04:00 停机维护，期间外置登录不可用。'),
  encode('mail.transport', 'smtp'),
  encode('mail.from', { address: 'noreply@example.test', name: '' }),
]

function encode<K extends Parameters<typeof encodeSettingValue>[0]>(
  key: K,
  value: Parameters<typeof encodeSettingValue<K>>[1],
) {
  return { key, value: encodeSettingValue(key, value, { secretKey: secretKey! }) }
}

const db = createDatabase<CoreDatabase>({ dialect: 'sqlite', file: join(resolve(directory), 'nextskin.sqlite') })
try {
  const now = toIsoTimestamp(new Date())
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom('settings')
      .where('namespace', '=', 'core')
      .where(
        'key',
        'in',
        values.map((row) => row.key),
      )
      .execute()
    await tx
      .insertInto('settings')
      .values(values.map((row) => ({ namespace: 'core', updated_at: now, ...row })))
      .execute()
  })
} finally {
  await db.destroy()
}
