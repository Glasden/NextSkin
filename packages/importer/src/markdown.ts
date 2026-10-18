// 对账报告的 Markdown：命令行写进文件，网页上下载的是同一份
import type { BlockingIssue, CappedList, ImportReport, TableStats, UuidSource } from './report.ts'

const REASONS: Record<string, string> = {
  duplicate_email: '邮箱重复',
  unknown_permission: '权限值不认识，按普通用户导入',
  invalid_register_at: '注册时间无效，取导入时刻',
  unsupported_locale: '语言不受支持，置空',
  unrecognized_password: '密码哈希认不出，没有导入密码（可以用找回密码重设）',
  avatar_missing: '头像的材质不存在或被跳过，置空',
  user_missing: '用户不存在',
  duplicate_name: '角色名重复',
  uuid_unresolved: 'UUID 待裁决',
  duplicate_uuid: 'UUID 重复',
  skin_missing: '皮肤的材质不存在或被跳过，置空',
  cape_missing: '披风的材质不存在或被跳过，置空',
  invalid_last_modified: '修改时间无效，取导入时刻',
  invalid_type: '类型不认识',
  invalid_hash: 'hash 的格式不对',
  file_missing: '文件缺失',
  file_undecodable: '文件无法解码',
  uploader_missing: '上传者不存在，置空',
  invalid_upload_at: '上传时间无效，取导入时刻',
  texture_missing: '材质不存在或被跳过',
  duplicate: '重复的行',
  invalid_status: '状态值不认识',
  reporter_missing: '举报人不存在，置空',
  invalid_report_at: '举报时间无效，取导入时刻',
  unsupported_client: '个人访问令牌或密码授权的客户端，不再支持',
}

const TABLE_NAMES: Record<keyof ImportReport['tables'], string> = {
  users: '用户（users）',
  players: '角色（players）',
  textures: '材质（textures）',
  closet: '衣柜（user_closet）',
  reports: '举报（reports）',
  oauthClients: 'OAuth 客户端（oauth_clients）',
}

const UUID_SOURCES: Record<UuidSource, string> = {
  pid: '映射表，按 pid',
  name: '映射表，按名字',
  override: '指定（--uuid-overrides）',
  offline: '离线算法生成',
  random: '随机生成',
}

const cell = (value: unknown) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
const code = (value: string) => `\`${value.replaceAll('`', 'ˋ')}\``

function more(list: CappedList<unknown>): string {
  return list.total > list.items.length ? `\n\n（共 ${list.total} 项，只列出前 ${list.items.length} 项）` : ''
}

export function describeIssue(issue: BlockingIssue): string {
  switch (issue.code) {
    case 'target_not_empty': {
      const current = `用户 ${issue.current.users}、角色 ${issue.current.players}、材质 ${issue.current.textures}`
      if (issue.needs === 'replace')
        return `目标库里有上一次导入的数据（${current}）。重新导入会整库替换：命令行加 \`--replace\`，网页上勾选确认。`
      const data = issue.newData
      const fresh = data
        ? `会话 ${data.sessions}、OAuth 令牌和授权 ${data.oauthTokens}、启动器令牌 ${data.launcherTokens}、` +
          `积分流水 ${data.scoreTransactions}、用户 ${data.users}、新建或改过的角色 ${data.players}、` +
          `新建或改过的材质 ${data.textures}、衣柜 ${data.closetItems}、新的或处理过的举报 ${data.reports}、` +
          `OAuth 客户端 ${data.oauthClients}、审计记录 ${data.auditLogs}、其他（找回密码、两步验证、通行密钥、后台任务等）${data.other}`
        : current
      return (
        `目标库里有新站产生的数据（${fresh}），或者有数据却从没导入过。新站多半已经在用，再导入会冲掉玩家在新站的操作。` +
        `确实要删除时：命令行加 \`--replace --force\`，网页上再勾选一次"删除新站的数据"。`
      )
    }
    case 'id_out_of_range':
      return `\`${issue.table}\` 的最大 id 是 ${issue.maxId}，超过 2147483647，NextSkin 的主键放不下（BS 里引用它的列也放不下）。请在旧站处理这些行。`
    case 'duplicate_email':
      return `邮箱 ${code(issue.email)} 转小写、去首尾空格后重复：uid ${issue.uids.join('、')}。请在旧站修改其中的邮箱，或者合并账号。`
    case 'duplicate_player_name':
      return (
        `角色名 ${issue.players.map((player) => `${code(player.name)}（pid ${player.pid}）`).join('、')} 只差大小写。` +
        `NextSkin 里角色名不区分大小写地唯一，请在旧站给其中的角色改名。`
      )
    case 'duplicate_uuid':
      return `UUID ${code(issue.uuid)} 被多个角色使用：pid ${issue.pids.join('、')}。请在旧站修正 uuid 表，或者用 \`--uuid-overrides\` 给其中的角色指定 UUID。`
    case 'uuid_ambiguous':
      return (
        `角色 ${code(issue.name)}（pid ${issue.pid}）在 uuid 表里有多个不同的候选值：` +
        issue.candidates
          .map(
            (candidate) =>
              `${code(candidate.value)}（${candidate.source === 'pid' ? '按 pid' : '按名字'}，行 ${candidate.rowId}，名字 ${code(candidate.name)}）`,
          )
          .join('、') +
        `。BS 查找时用的 first() 没有排序，在 MySQL InnoDB 上实际返回 id 最小的一行，PostgreSQL 上则不一定。` +
        `请在旧站删掉多余的映射行，或者用 \`--uuid-overrides\` 指定。`
      )
    case 'uuid_invalid':
      return `角色 ${code(issue.name)}（pid ${issue.pid}）的映射行 ${issue.candidate.rowId} 存的 ${code(issue.candidate.value)} 不是合法的 UUID。请在旧站修正，或者用 \`--uuid-overrides\` 指定。`
    case 'uuid_override_invalid':
      return `\`--uuid-overrides\` 里 ${code(issue.pid)} 的值 ${code(issue.value)} 不对：键是 pid，值是 32 位十六进制的 UUID，可以带连字符。`
    case 'uuid_override_unknown_player':
      return `\`--uuid-overrides\` 指定了 pid ${issue.pid}，旧库里没有这个角色。`
    case 'password_method_required':
      return (
        `${issue.total} 个用户的密码哈希是十六进制摘要（例如 uid ${issue.uids.slice(0, 10).join('、')}），没有提供旧站的 .env，不知道是哪种算法。` +
        `不知道算法就导入，这些用户全都登录不了。请用 \`--bs-env\` 提供旧站的 .env（导入器从里面读 PWD_METHOD 和 SALT）。`
      )
    case 'regex_unsupported':
      return `设置 \`${issue.option}\` 的正则 ${code(issue.value)} 转不成 JavaScript 的写法（只支持修饰符 i、m、s、u）。请在旧站改写或者清空它。`
    case 'text_too_long':
      return `\`${issue.option}\` 有 ${issue.length} 个字符，超过 20000。请在旧站缩短。`
    case 'verification_failed':
      return `读回比对发现 ${issue.mismatches} 处不一致（见"比对"一节）。这是导入器的问题，请附上这份报告反馈。`
  }
}

function tableRows(tables: ImportReport['tables']): string[] {
  const lines = ['| 表 | 旧库 | 导入 | 跳过 | 调整 |', '|---|---|---|---|---|']
  const reasons = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([reason, count]) => `${REASONS[reason] ?? reason} ${count}`)
      .join('；') || '—'
  for (const [key, stats] of Object.entries(tables) as [keyof ImportReport['tables'], TableStats][])
    lines.push(
      `| ${TABLE_NAMES[key]} | ${stats.source} | ${stats.imported} | ${cell(reasons(stats.skipped))} | ${cell(reasons(stats.adjusted))} |`,
    )
  return lines
}

export function reportToMarkdown(report: ImportReport): string {
  const lines: string[] = []
  const source = report.source
  const where =
    source.dialect === 'sqlite'
      ? `SQLite ${source.file}`
      : `${source.dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} ${source.username}@${source.host}:${source.port}/${source.database}`
  lines.push(`# 从 BS 导入的对账报告${report.dryRun ? '（试跑）' : ''}`, '')
  lines.push(
    `- 时间：${report.startedAt} – ${report.finishedAt}`,
    `- 旧库：${where}${source.prefix ? `，表前缀 \`${source.prefix}\`` : ''}${source.bsVersion ? `，BS ${source.bsVersion}` : ''}`,
    `- 材质目录：${source.texturesDirectory}`,
    `- 时区：${source.timeZone}；密码算法：${source.passwordMethod}`,
    `- UUID 映射表：${source.uuidTable === 'none' ? '没有' : source.uuidTable}`,
  )
  lines.push(
    '',
    report.error
      ? `**运行没有完成：${report.error}。目标库没有任何改动，下面的内容只到中断时为止。**`
      : report.blocking.total
        ? `**有 ${report.blocking.total} 个停止类问题，目标库没有任何改动。** 在旧站处理之后重新试跑。`
        : report.dryRun
          ? '没有停止类问题。试跑的结果已经回滚，真正导入时报告与这份相同。'
          : '没有停止类问题，导入已经提交。',
  )

  lines.push('', `## 停止类问题（${report.blocking.total}）`, '')
  if (!report.blocking.total) lines.push('没有。')
  for (const issue of report.blocking.items) lines.push(`- ${describeIssue(issue)}`)
  if (report.blocking.total) lines.push(more(report.blocking).trim())

  lines.push('', '## UUID', '')
  lines.push('| 来源 | 角色数 |', '|---|---|')
  for (const [source, count] of Object.entries(report.uuid.counts))
    lines.push(`| ${UUID_SOURCES[source as UuidSource]} | ${count} |`)
  lines.push('', `没有对应角色的映射行（改名或删除角色后留下的，不导入）：${report.uuid.orphanMappings}`)
  if (report.uuid.generated.total) {
    lines.push('', '### 不是从映射表取来的 UUID', '', '| pid | 角色名 | UUID | 来源 |', '|---|---|---|---|')
    for (const item of report.uuid.generated.items)
      lines.push(`| ${item.pid} | ${cell(item.name)} | ${item.uuid} | ${UUID_SOURCES[item.source]} |`)
    lines.push(more(report.uuid.generated))
  }
  if (report.uuid.nameMismatches.total) {
    lines.push(
      '',
      '### 映射行的名字与角色名不完全相同',
      '',
      '仍然用表里存的值。BS 继续运行的话，下一次读取可能把它换掉，NextSkin 不换（ADR-0015）。',
      '',
      '| pid | 角色名 | 映射行的名字 | UUID |',
      '|---|---|---|---|',
    )
    for (const item of report.uuid.nameMismatches.items)
      lines.push(`| ${item.pid} | ${cell(item.name)} | ${cell(item.mappingName)} | ${cell(item.uuid)} |`)
    lines.push(more(report.uuid.nameMismatches))
  }

  lines.push(
    '',
    '## 比对',
    '',
    `用协议端点的查询读回了 ${report.verification.checked} 个角色，与旧库比对 UUID、皮肤和披风的 hash、模型。`,
  )
  if (report.verification.mismatches.total) {
    lines.push('', '| pid | 角色名 | 项 | 旧库 | 读回 |', '|---|---|---|---|---|')
    for (const item of report.verification.mismatches.items)
      lines.push(
        `| ${item.pid} | ${cell(item.name)} | ${item.field} | ${cell(item.expected ?? '—')} | ${cell(item.actual ?? '—')} |`,
      )
    lines.push(more(report.verification.mismatches))
  } else if (!report.error) lines.push('', '全部一致。')

  lines.push('', '## 各表', '', ...tableRows(report.tables))

  const files = report.files
  lines.push(
    '',
    '## 材质文件',
    '',
    `导入 ${files.total} 个文件：解码 ${files.decoded}，沿用上一次导入的像素 hash ${files.reused}；` +
      (report.dryRun ? '试跑不复制文件。' : `复制 ${files.copied}，存储里已有 ${files.alreadyStored}。`),
  )
  for (const [title, list] of [
    ['缺失的文件（引用它们的材质被跳过）', files.missing],
    ['无法解码的文件（引用它们的材质被跳过）', files.undecodable],
  ] as const) {
    if (!list.total) continue
    lines.push('', `### ${title}`, '', '| hash | 引用它的 tid |', '|---|---|')
    for (const item of list.items) lines.push(`| ${item.hash} | ${item.tids.join('、')} |`)
    lines.push(more(list))
  }
  if (files.nonconforming.total) {
    lines.push('', '### 尺寸不合 NextSkin 规则的文件（照样导入）', '', '| hash | 类型 | 宽 × 高 |', '|---|---|---|')
    for (const item of files.nonconforming.items)
      lines.push(`| ${item.hash} | ${item.type} | ${item.width} × ${item.height} |`)
    lines.push(more(files.nonconforming))
  }

  const settings = report.settings
  lines.push(
    '',
    '## 设置',
    '',
    `导入了 ${settings.imported.length} 项：${settings.imported.map((key) => `\`${key}\``).join('、') || '—'}`,
  )
  if (settings.clamped.length) {
    lines.push('', '超出范围、取了边界值的：')
    for (const item of settings.clamped) lines.push(`- \`${item.key}\`：${item.from} → ${item.to}`)
  }
  if (settings.invalid.length) {
    lines.push('', '值不合法、没有导入的（用 NextSkin 的默认值）：')
    for (const item of settings.invalid) lines.push(`- \`${item.option}\`：${code(item.value)}`)
  }
  if (settings.notImported.length) {
    lines.push('', '不导入、但旧站改过的设置：')
    for (const item of settings.notImported) lines.push(`- \`${item.option}\`：${code(item.value)}`)
  }
  if (settings.notImported.some((item) => item.option === 'copyright_text'))
    lines.push('', '旧站版权文字是原始 HTML，请改写成 Markdown 后填进 site.footer；备案号链接也需要改写。')
  if (settings.otherLocales.length)
    lines.push(
      '',
      `公告、内容政策和站点描述的其他语言版本，没有导入：${settings.otherLocales.map((key) => `\`${key}\``).join('、')}`,
    )
  if (settings.rawHtml.length)
    lines.push(
      '',
      `含原始 HTML，导入后这部分不再显示（ADR-0028）：${settings.rawHtml.map((key) => `\`${key}\``).join('、')}`,
    )

  lines.push(
    '',
    '## 衣柜和举报',
    '',
    `- 衣柜里去掉的重复行：${report.closet.duplicates}`,
    `- 重复的举报（同一个人对同一个材质，只保留 id 最小的一条）：${report.reports.duplicates}`,
    `- 材质已经不存在的待处理举报，记为已结案：${report.reports.autoResolved}，退还举报人的积分共 ${report.reports.refunded}`,
  )
  if (report.likes.total) {
    lines.push('', '### 收藏数重新统计后与旧库不同的材质', '', '| tid | 旧库 | 重新统计 |', '|---|---|---|')
    for (const item of report.likes.items) lines.push(`| ${item.tid} | ${item.before} | ${item.after} |`)
    lines.push(more(report.likes))
  }

  lines.push('', '## 认不出的表', '')
  if (!report.unknownTables.length) lines.push('没有。')
  else {
    lines.push('这些表的数据没有迁移，例如其他插件的数据：', '', '| 表 | 行数 |', '|---|---|')
    for (const table of report.unknownTables) lines.push(`| ${table.name} | ${table.rows} |`)
  }

  const target = report.target
  lines.push(
    '',
    '## 目标库',
    '',
    `导入前：用户 ${target.before.users}、角色 ${target.before.players}、材质 ${target.before.textures}；` +
      (target.lastImportAt ? `上一次导入完成于 ${target.lastImportAt}。` : '没有导入过。'),
  )
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
}
