import type { AuditEntry } from '@nextskin/domain'
import { Link, Table } from '@nextskin/ui'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { auditHref } from './params'

type Column = 'time' | 'actor' | 'action' | 'subject' | 'details' | 'ip'

// 审计记录的动作名带点号（`report.resolve`），next-intl 的键不能带点号，换成驼峰的键
const actionKeys = {
  'report.resolve': 'reportResolve',
  'texture.delete': 'textureDelete',
  'user.setRole': 'userSetRole',
} as const

// 处理举报的 details.action 可能是接口的动作，也可能是 SDK 的处理方式，都映射到同一份文案
const resolutionKeys = {
  dismiss: 'dismissed',
  dismissed: 'dismissed',
  deleteTexture: 'textureDeleted',
  textureDeleted: 'textureDeleted',
  banUploader: 'uploaderBanned',
  uploaderBanned: 'uploaderBanned',
} as const

const roles = ['banned', 'user', 'admin', 'superadmin'] as const
const textureTypes = ['steve', 'alex', 'cape'] as const

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null
}

/**
 * 审计记录的表格，概览页和审计日志页共用（ADR-0027）。操作者的名字链接到只看他的记录；
 * 对象还在的，链接到它；已经删除的，显示 details 里的快照
 */
export async function AuditTable({
  entries,
  label,
  empty,
}: {
  entries: readonly AuditEntry[]
  label: string
  empty: string
}) {
  const [t, admin, reports, types, format] = await Promise.all([
    getTranslations('admin.audit'),
    getTranslations('admin'),
    getTranslations('admin.reports'),
    getTranslations('skinlib.types'),
    getFormatter(),
  ])
  const columns = [
    { key: 'time', header: t('columns.time'), shrink: true },
    { key: 'actor', header: t('columns.actor') },
    { key: 'action', header: t('columns.action'), shrink: true },
    { key: 'subject', header: t('columns.subject') },
    { key: 'details', header: t('columns.details') },
    { key: 'ip', header: t('columns.ip'), shrink: true },
  ] as const
  const role = (value: unknown) => {
    const known = oneOf(roles, value)
    return known ? admin(`roles.${known}`) : (text(value) ?? '')
  }

  function actor(entry: AuditEntry) {
    if (entry.actor.type === 'system') return <span className="text-text-muted">{t('actorSystem')}</span>
    if (entry.actor.type === 'plugin') return t('actorPlugin', { id: entry.actor.pluginId })
    const { uid, nickname } = entry.actor
    return (
      <Link render={<NextLink href={auditHref({ subject: null, actor: uid, page: 1 })} />}>
        {nickname ?? t('actorGone', { uid })}
      </Link>
    )
  }

  function subject(entry: AuditEntry) {
    const { type, id, exists } = entry.subject
    const label =
      type === 'user' || type === 'texture' || type === 'report'
        ? t(`subjects.${type}`, { id })
        : t('subjects.other', { type, id })
    const snapshot = text(entry.details.name) ?? text(entry.details.nickname)
    const href = !exists
      ? null
      : type === 'user'
        ? `/admin/users?q=${id}`
        : type === 'texture'
          ? `/skinlib/${id}`
          : null
    return (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        {href ? (
          <Link render={<NextLink href={href} />}>{label}</Link>
        ) : (
          <span className="whitespace-nowrap">{label}</span>
        )}
        {snapshot && <span className="min-w-0 truncate text-text-muted">{snapshot}</span>}
      </span>
    )
  }

  function details(entry: AuditEntry) {
    const via =
      typeof entry.details.reportId === 'number' ? t('details.viaReport', { id: entry.details.reportId }) : null
    let summary: string | null = null
    if (entry.action === 'report.resolve') {
      const resolution = oneOf(Object.keys(resolutionKeys) as (keyof typeof resolutionKeys)[], entry.details.action)
      summary = t('details.reportResolve', {
        action: resolution ? reports(`resolutions.${resolutionKeys[resolution]}`) : (text(entry.details.action) ?? ''),
        refunded: count(entry.details.refunded),
        rewarded: count(entry.details.rewarded),
      })
    } else if (entry.action === 'texture.delete') {
      const type = oneOf(textureTypes, entry.details.type)
      summary = t('details.textureDelete', {
        name: text(entry.details.name) ?? '',
        type: type ? types(type) : (text(entry.details.type) ?? ''),
      })
    } else if (entry.action === 'user.setRole') {
      summary = t('details.userSetRole', { from: role(entry.details.from), to: role(entry.details.to) })
    }
    return (
      <span className="flex flex-col">
        {summary && <span>{summary}</span>}
        {via && <span className="text-xs text-text-muted">{via}</span>}
      </span>
    )
  }

  return (
    <Table<Column>
      label={label}
      empty={empty}
      columns={columns}
      rows={entries.map((entry) => ({
        key: entry.id,
        cells: {
          time: format.dateTime(new Date(entry.createdAt), { dateStyle: 'short', timeStyle: 'short' }),
          actor: actor(entry),
          action:
            entry.action in actionKeys
              ? t(`actions.${actionKeys[entry.action as keyof typeof actionKeys]}`)
              : entry.action,
          subject: subject(entry),
          details: details(entry),
          ip: entry.ip ? (
            <span className="font-mono text-xs">{entry.ip}</span>
          ) : (
            <span className="text-text-muted">—</span>
          ),
        },
      }))}
    />
  )
}
