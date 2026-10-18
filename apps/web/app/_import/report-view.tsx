'use client'

import type { BlockingIssue, ImportReport, UuidSource } from '@nextskin/importer'
import { Alert, Badge, Select, Table, Tabs } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'

export type RunStatus = 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled'

const statusTones = {
  running: 'neutral',
  succeeded: 'success',
  blocked: 'danger',
  failed: 'danger',
  cancelled: 'neutral',
} as const

const uuidSources: readonly UuidSource[] = ['pid', 'name', 'override', 'offline', 'random']
const tableKeys = ['users', 'players', 'textures', 'closet', 'reports', 'oauthClients'] as const
const newDataKeys = [
  'sessions',
  'oauthTokens',
  'launcherTokens',
  'scoreTransactions',
  'users',
  'players',
  'textures',
  'closetItems',
  'reports',
  'oauthClients',
  'auditLogs',
  'other',
] as const

/** 试跑报告里 UUID 冲突的选择：pid → 选中的 UUID，下一次运行作为 uuidOverrides 传上去 */
export interface UuidChoices {
  selected: Readonly<Record<string, string>>
  /** uuid 为空串表示取消选择 */
  onSelect: (pid: number, uuid: string) => void
}

/**
 * 对账报告（ADR-0031）：按结构化的数据渲染。停止类问题和 UUID 在最前面，其余分节放进标签页。
 * 试跑的向导里传 choices：UUID 有多个候选值的角色可以逐个选择
 */
export function ReportView({
  report,
  status,
  choices,
}: {
  report: ImportReport
  status: RunStatus
  choices?: UuidChoices
}) {
  const t = useTranslations('import.report')
  const format = useFormatter()
  const [tab, setTab] = useState<'tables' | 'files' | 'settings' | 'other'>('tables')
  const number = (value: number) => format.number(value)
  const seconds = Math.max(0, Math.round((Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000))

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTones[status]}>{t(`status.${status}`)}</Badge>
          {report.dryRun && <Badge>{t('dryRun')}</Badge>}
          <span className="text-sm text-text-muted">
            {t('timing', {
              time: format.dateTime(new Date(report.startedAt), { dateStyle: 'medium', timeStyle: 'short' }),
              seconds,
            })}
          </span>
        </div>
      </section>

      {report.error && (
        <Alert tone="danger" title={t(status === 'cancelled' ? 'cancelled' : 'error')}>
          {status === 'cancelled' ? t('cancelledHint') : report.error}
        </Alert>
      )}

      {report.blocking.total > 0 && (
        <section className="flex flex-col gap-3">
          <Alert tone="danger" title={t('blocking.title', { count: report.blocking.total })}>
            {t('blocking.hint')}
          </Alert>
          <ol className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
            {report.blocking.items.map((issue, index) => (
              <li key={index} className="flex flex-col gap-3 p-4 text-sm text-text">
                <IssueText issue={issue} />
                {issue.code === 'uuid_ambiguous' && choices && <UuidChoice issue={issue} choices={choices} />}
              </li>
            ))}
          </ol>
          <Truncated shown={report.blocking.items.length} total={report.blocking.total} />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-pixel text-pixel-1 text-text-muted">{t('uuid.title')}</h2>
        <p className="text-sm text-pretty text-text-muted">{t('uuid.description')}</p>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {uuidSources.map((key) => (
            <Stat key={key} label={t(`uuid.sources.${key}`)} value={number(report.uuid.counts[key])} />
          ))}
        </dl>
        {report.uuid.orphanMappings > 0 && (
          <p className="text-sm text-text-muted">{t('uuid.orphans', { count: report.uuid.orphanMappings })}</p>
        )}
        {report.uuid.nameMismatches.total > 0 && (
          <Subsection title={t('uuid.mismatches')}>
            <Table
              label={t('uuid.mismatches')}
              empty={t('none')}
              columns={[
                { key: 'pid', header: t('columns.pid'), align: 'end', shrink: true },
                { key: 'name', header: t('columns.player') },
                { key: 'mappingName', header: t('columns.mappingName') },
                { key: 'uuid', header: t('columns.uuid') },
              ]}
              rows={report.uuid.nameMismatches.items.map((row) => ({
                key: row.pid,
                cells: {
                  pid: <span className="font-mono">{row.pid}</span>,
                  name: row.name,
                  mappingName: row.mappingName,
                  uuid: <span className="font-mono">{row.uuid}</span>,
                },
              }))}
            />
            <Truncated shown={report.uuid.nameMismatches.items.length} total={report.uuid.nameMismatches.total} />
          </Subsection>
        )}
        {report.uuid.generated.total > 0 && (
          <Subsection title={t('uuid.generated')}>
            <Table
              label={t('uuid.generated')}
              empty={t('none')}
              columns={[
                { key: 'pid', header: t('columns.pid'), align: 'end', shrink: true },
                { key: 'name', header: t('columns.player') },
                { key: 'uuid', header: t('columns.uuid') },
                { key: 'source', header: t('columns.uuidSource'), shrink: true },
              ]}
              rows={report.uuid.generated.items.slice(0, 50).map((row) => ({
                key: row.pid,
                cells: {
                  pid: <span className="font-mono">{row.pid}</span>,
                  name: row.name,
                  uuid: <span className="font-mono">{row.uuid}</span>,
                  source: t(`uuid.sources.${row.source}`),
                },
              }))}
            />
            <Truncated shown={Math.min(report.uuid.generated.items.length, 50)} total={report.uuid.generated.total} />
          </Subsection>
        )}
      </section>

      <Tabs
        aria-label={t('tabs.label')}
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'tables', label: t('tabs.tables') },
          { value: 'files', label: t('tabs.files') },
          { value: 'settings', label: t('tabs.settings') },
          { value: 'other', label: t('tabs.other') },
        ]}
      >
        {tab === 'tables' && <TablesSection report={report} />}
        {tab === 'files' && <FilesSection report={report} />}
        {tab === 'settings' && <SettingsSection report={report} />}
        {tab === 'other' && <OtherSection report={report} />}
      </Tabs>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-x-6 sm:flex-row">
      <dt className="shrink-0 text-text-muted sm:w-32">{label}</dt>
      <dd className="min-w-0 text-text">{children}</dd>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface p-3">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="font-pixel text-pixel-2 text-text tabular-nums">{value}</dd>
    </div>
  )
}

function Subsection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-text">{title}</h3>
      {description && <p className="text-sm text-pretty text-text-muted">{description}</p>}
      {children}
    </div>
  )
}

function Truncated({ shown, total }: { shown: number; total: number }) {
  const t = useTranslations('import.report')
  return total > shown ? <p className="text-xs text-text-muted">{t('truncated', { shown, total })}</p> : null
}

/** 停止类问题的说明：发生了什么，在旧站怎么处理（DESIGN.md §8） */
function IssueText({ issue }: { issue: BlockingIssue }) {
  const t = useTranslations('import.report.issues')
  const list = (values: readonly (string | number)[]) => values.join(', ')
  switch (issue.code) {
    case 'target_not_empty':
      return <p>{t(issue.needs === 'replace' ? 'targetReplace' : 'targetForce', { ...issue.current })}</p>
    case 'id_out_of_range':
      return <p>{t('idOutOfRange', { table: issue.table, maxId: issue.maxId })}</p>
    case 'duplicate_email':
      return <p>{t('duplicateEmail', { email: issue.email, uids: list(issue.uids) })}</p>
    case 'duplicate_player_name':
      return (
        <p>
          {t('duplicatePlayerName', {
            players: list(issue.players.map((player) => `${player.name} (pid ${player.pid})`)),
          })}
        </p>
      )
    case 'duplicate_uuid':
      return <p>{t('duplicateUuid', { uuid: issue.uuid, pids: list(issue.pids) })}</p>
    case 'uuid_ambiguous':
      return <p>{t('uuidAmbiguous', { name: issue.name, pid: issue.pid })}</p>
    case 'uuid_invalid':
      return (
        <p>
          {t('uuidInvalid', {
            name: issue.name,
            pid: issue.pid,
            row: issue.candidate.rowId,
            value: issue.candidate.value,
          })}
        </p>
      )
    case 'uuid_override_invalid':
      return <p>{t('uuidOverrideInvalid', { pid: issue.pid, value: issue.value })}</p>
    case 'uuid_override_unknown_player':
      return <p>{t('uuidOverrideUnknownPlayer', { pid: issue.pid })}</p>
    case 'password_method_required':
      return <p>{t('passwordMethodRequired', { total: issue.total, uids: list(issue.uids.slice(0, 10)) })}</p>
    case 'regex_unsupported':
      return <p>{t('regexUnsupported', { option: issue.option, value: issue.value })}</p>
    case 'text_too_long':
      return <p>{t('textTooLong', { option: issue.option, length: issue.length })}</p>
    case 'verification_failed':
      return <p>{t('verificationFailed', { count: issue.mismatches })}</p>
  }
}

/** 选一个候选值：选游戏服务器上正在用的那个（UUID 一变，玩家在服务器上的数据就对不上了） */
function UuidChoice({
  issue,
  choices,
}: {
  issue: Extract<BlockingIssue, { code: 'uuid_ambiguous' }>
  choices: UuidChoices
}) {
  const t = useTranslations('import.report.choice')
  const values = [...new Set(issue.candidates.map((candidate) => candidate.value))]
  const selected = choices.selected[String(issue.pid)]
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {issue.candidates.map((candidate) => (
          <li key={candidate.rowId} className="flex flex-wrap items-baseline gap-x-3 text-text-muted">
            <span className="font-mono text-text">{candidate.value}</span>
            {t('candidate', { source: candidate.source, row: candidate.rowId, name: candidate.name })}
          </li>
        ))}
      </ul>
      <div className="flex max-w-md flex-col gap-1">
        <span className="text-text-muted">{t('label', { name: issue.name })}</span>
        <Select
          size="sm"
          aria-label={t('label', { name: issue.name })}
          options={[{ value: '', label: t('placeholder') }, ...values.map((value) => ({ value, label: value }))]}
          value={selected ?? ''}
          onValueChange={(value) => choices.onSelect(issue.pid, value)}
        />
      </div>
    </div>
  )
}

// 跳过和调整的原因（导入器的 bump 键）。导入器以后加了新原因而这里没跟上时，原样显示键名
const reasonKeys = [
  'duplicate_email',
  'unknown_permission',
  'invalid_register_at',
  'unsupported_locale',
  'unrecognized_password',
  'avatar_missing',
  'user_missing',
  'duplicate_name',
  'uuid_unresolved',
  'duplicate_uuid',
  'skin_missing',
  'cape_missing',
  'invalid_last_modified',
  'invalid_type',
  'invalid_hash',
  'file_missing',
  'file_undecodable',
  'uploader_missing',
  'invalid_upload_at',
  'texture_missing',
  'duplicate',
  'invalid_status',
  'reporter_missing',
  'invalid_report_at',
  'unsupported_client',
] as const

function isReason(value: string): value is (typeof reasonKeys)[number] {
  return (reasonKeys as readonly string[]).includes(value)
}

function Reasons({ counts }: { counts: Readonly<Record<string, number>> }) {
  const t = useTranslations('import.report.reasons')
  const format = useFormatter()
  const entries = Object.entries(counts).filter(([, count]) => count > 0)
  if (!entries.length) return <span className="text-text-muted">0</span>
  return (
    <ul className="flex flex-col gap-0.5">
      {entries.map(([reason, count]) => (
        <li key={reason}>
          {isReason(reason) ? t(reason) : reason} <span className="tabular-nums">{format.number(count)}</span>
        </li>
      ))}
    </ul>
  )
}

function TablesSection({ report }: { report: ImportReport }) {
  const t = useTranslations('import.report.tables')
  const format = useFormatter()
  return (
    <Table
      label={t('label')}
      empty=""
      columns={[
        { key: 'table', header: t('columns.table') },
        { key: 'source', header: t('columns.source'), align: 'end', shrink: true },
        { key: 'imported', header: t('columns.imported'), align: 'end', shrink: true },
        { key: 'skipped', header: t('columns.skipped') },
        { key: 'adjusted', header: t('columns.adjusted') },
      ]}
      rows={tableKeys.map((key) => {
        const stats = report.tables[key]
        return {
          key,
          cells: {
            table: t(`names.${key}`),
            source: <span className="tabular-nums">{format.number(stats.source)}</span>,
            imported: <span className="tabular-nums">{format.number(stats.imported)}</span>,
            skipped: <Reasons counts={stats.skipped} />,
            adjusted: <Reasons counts={stats.adjusted} />,
          },
        }
      })}
    />
  )
}

function HashTable({ title, list }: { title: string; list: ImportReport['files']['missing'] }) {
  const t = useTranslations('import.report')
  if (!list.total) return null
  return (
    <Subsection title={title}>
      <Table
        label={title}
        empty={t('none')}
        columns={[
          { key: 'hash', header: t('columns.hash') },
          { key: 'tids', header: t('columns.tids') },
        ]}
        rows={list.items.map((row) => ({
          key: row.hash,
          cells: {
            hash: <span className="font-mono break-all">{row.hash}</span>,
            tids: <span className="font-mono">{row.tids.join(', ')}</span>,
          },
        }))}
      />
      <Truncated shown={list.items.length} total={list.total} />
    </Subsection>
  )
}

function FilesSection({ report }: { report: ImportReport }) {
  const t = useTranslations('import.report')
  const format = useFormatter()
  const { files } = report
  const stats = ['total', 'decoded', 'reused', 'copied', 'alreadyStored'] as const
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map((key) => (
          <Stat key={key} label={t(`files.${key}`)} value={format.number(files[key])} />
        ))}
      </dl>
      {report.dryRun && <p className="text-sm text-text-muted">{t('files.dryRunCopy')}</p>}
      <HashTable title={t('files.missing')} list={files.missing} />
      <HashTable title={t('files.undecodable')} list={files.undecodable} />
      {files.nonconforming.total > 0 && (
        <Subsection title={t('files.nonconforming')} description={t('files.nonconformingHint')}>
          <Table
            label={t('files.nonconforming')}
            empty={t('none')}
            columns={[
              { key: 'hash', header: t('columns.hash') },
              { key: 'type', header: t('columns.type'), shrink: true },
              { key: 'size', header: t('columns.size'), align: 'end', shrink: true },
            ]}
            rows={files.nonconforming.items.map((row) => ({
              key: row.hash,
              cells: {
                hash: <span className="font-mono break-all">{row.hash}</span>,
                type: row.type,
                size: <span className="tabular-nums">{`${row.width} × ${row.height}`}</span>,
              },
            }))}
          />
          <Truncated shown={files.nonconforming.items.length} total={files.nonconforming.total} />
        </Subsection>
      )}
    </div>
  )
}

function ValueTable({
  title,
  description,
  rows,
}: {
  title: string
  description?: string
  rows: readonly { option: string; value: string }[]
}) {
  const t = useTranslations('import.report')
  if (!rows.length) return null
  return (
    <Subsection title={title} description={description}>
      <Table
        label={title}
        empty={t('none')}
        columns={[
          { key: 'option', header: t('columns.option') },
          { key: 'value', header: t('columns.value') },
        ]}
        rows={rows.map((row) => ({
          key: row.option,
          cells: {
            option: <span className="font-mono">{row.option}</span>,
            value: <span className="font-mono break-all">{row.value}</span>,
          },
        }))}
      />
    </Subsection>
  )
}

function SettingsSection({ report }: { report: ImportReport }) {
  const t = useTranslations('import.report')
  const { settings } = report
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-text">{t('settings.imported', { count: settings.imported.length })}</p>
      {settings.clamped.length > 0 && (
        <Subsection title={t('settings.clamped')}>
          <Table
            label={t('settings.clamped')}
            empty={t('none')}
            columns={[
              { key: 'key', header: t('columns.setting') },
              { key: 'from', header: t('columns.from') },
              { key: 'to', header: t('columns.to') },
            ]}
            rows={settings.clamped.map((row) => ({
              key: row.key,
              cells: {
                key: <span className="font-mono">{row.key}</span>,
                from: <span className="font-mono break-all">{row.from}</span>,
                to: <span className="font-mono break-all">{row.to}</span>,
              },
            }))}
          />
        </Subsection>
      )}
      <ValueTable title={t('settings.invalid')} rows={settings.invalid} />
      <ValueTable
        title={t('settings.notImported')}
        description={t('settings.notImportedHint')}
        rows={settings.notImported}
      />
      {settings.otherLocales.length > 0 && (
        <Subsection title={t('settings.otherLocales')} description={t('settings.otherLocalesHint')}>
          <p className="font-mono text-sm text-text">{settings.otherLocales.join(', ')}</p>
        </Subsection>
      )}
      {settings.rawHtml.length > 0 && (
        <Subsection title={t('settings.rawHtml')} description={t('settings.rawHtmlHint')}>
          <p className="font-mono text-sm text-text">{settings.rawHtml.join(', ')}</p>
        </Subsection>
      )}
    </div>
  )
}

function OtherSection({ report }: { report: ImportReport }) {
  const t = useTranslations('import.report')
  const format = useFormatter()
  const { verification, target, source } = report
  const location =
    source.dialect === 'sqlite'
      ? `sqlite:${source.file}`
      : `${source.dialect}://${source.username}@${source.host}:${source.port}/${source.database}`
  return (
    <div className="flex flex-col gap-6">
      <Subsection title={t('other.source')}>
        <dl className="flex flex-col gap-2 text-sm">
          <Detail label={t('source.database')}>
            <span className="font-mono break-all">{location}</span>
          </Detail>
          <Detail label={t('source.prefix')}>
            <span className="font-mono">{source.prefix || t('none')}</span>
          </Detail>
          <Detail label={t('source.textures')}>
            <span className="font-mono break-all">{source.texturesDirectory}</span>
          </Detail>
          <Detail label={t('source.timeZone')}>{source.timeZone}</Detail>
          <Detail label={t('source.passwordMethod')}>{source.passwordMethod}</Detail>
          <Detail label={t('source.bsVersion')}>{source.bsVersion ?? t('unknown')}</Detail>
          <Detail label={t('source.uuidTable')}>{t(`source.uuidTables.${source.uuidTable}`)}</Detail>
        </dl>
      </Subsection>

      <Subsection title={t('other.verification')}>
        <p className="text-sm text-text">
          {t('other.verified', { count: verification.checked, mismatches: verification.mismatches.total })}
        </p>
        {verification.mismatches.total > 0 && (
          <>
            <Table
              label={t('other.verification')}
              empty={t('none')}
              columns={[
                { key: 'pid', header: t('columns.pid'), align: 'end', shrink: true },
                { key: 'name', header: t('columns.player') },
                { key: 'field', header: t('columns.field'), shrink: true },
                { key: 'expected', header: t('columns.expected') },
                { key: 'actual', header: t('columns.actual') },
              ]}
              rows={verification.mismatches.items.map((row, index) => ({
                key: `${row.pid}:${row.field}:${index}`,
                cells: {
                  pid: <span className="font-mono">{row.pid}</span>,
                  name: row.name,
                  field: t(`other.fields.${row.field}`),
                  expected: <span className="font-mono break-all">{row.expected ?? '—'}</span>,
                  actual: <span className="font-mono break-all">{row.actual ?? '—'}</span>,
                },
              }))}
            />
            <Truncated shown={verification.mismatches.items.length} total={verification.mismatches.total} />
          </>
        )}
      </Subsection>

      <Subsection title={t('other.closetAndReports')}>
        <ul className="flex flex-col gap-1 text-sm text-text">
          <li>{t('other.closetDuplicates', { count: report.closet.duplicates })}</li>
          <li>{t('other.reportStats', report.reports)}</li>
        </ul>
      </Subsection>

      {report.likes.total > 0 && (
        <Subsection title={t('other.likes')} description={t('other.likesHint')}>
          <Table
            label={t('other.likes')}
            empty={t('none')}
            columns={[
              { key: 'tid', header: t('columns.tid'), align: 'end', shrink: true },
              { key: 'before', header: t('columns.before'), align: 'end', shrink: true },
              { key: 'after', header: t('columns.after'), align: 'end', shrink: true },
            ]}
            rows={report.likes.items.map((row) => ({
              key: row.tid,
              cells: {
                tid: <span className="font-mono">{row.tid}</span>,
                before: <span className="tabular-nums">{format.number(row.before)}</span>,
                after: <span className="tabular-nums">{format.number(row.after)}</span>,
              },
            }))}
          />
          <Truncated shown={report.likes.items.length} total={report.likes.total} />
        </Subsection>
      )}

      {report.unknownTables.length > 0 && (
        <Subsection title={t('other.unknownTables')} description={t('other.unknownTablesHint')}>
          <Table
            label={t('other.unknownTables')}
            empty={t('none')}
            columns={[
              { key: 'name', header: t('columns.table') },
              { key: 'rows', header: t('columns.rows'), align: 'end', shrink: true },
            ]}
            rows={report.unknownTables.map((row) => ({
              key: row.name,
              cells: {
                name: <span className="font-mono">{row.name}</span>,
                rows: <span className="tabular-nums">{format.number(row.rows)}</span>,
              },
            }))}
          />
        </Subsection>
      )}

      <Subsection title={t('other.target')}>
        <ul className="flex flex-col gap-1 text-sm text-text">
          <li>{t('other.targetBefore', { ...target.before })}</li>
          <li>
            {target.lastImportAt
              ? t('other.lastImport', {
                  time: format.dateTime(new Date(target.lastImportAt), { dateStyle: 'medium', timeStyle: 'short' }),
                })
              : t('other.neverImported')}
          </li>
        </ul>
        {target.newData && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            {newDataKeys.map((key) => (
              <div key={key} className="flex justify-between gap-3">
                <dt className="text-text-muted">{t(`newData.${key}`)}</dt>
                <dd className="text-text tabular-nums">{format.number(target.newData![key])}</dd>
              </div>
            ))}
          </dl>
        )}
      </Subsection>
    </div>
  )
}
