'use client'

import type { DiagnosticsLogEntry, DiagnosticsLogPage } from '@nextskin/domain'
import type { LogLevel } from '@nextskin/logging'
import { Alert, Badge, Button, Input, Select, Table } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { apiError, getJson } from '../../../lib/api-client'
import { LOG_LEVELS, LOG_RECORD_FIELDS, LOG_SOURCES } from './diagnostics-text'

/** 停在第一页时多久取一次新的（ADR-0062） */
const POLL_MS = 5000

type Source = (typeof LOG_SOURCES)[number]

interface Filters {
  level: LogLevel | 'all'
  source: Source | 'all'
  text: string
}

const NO_FILTERS: Filters = { level: 'all', source: 'all', text: '' }

const LEVEL_TONES = {
  debug: 'neutral',
  info: 'neutral',
  warn: 'warning',
  error: 'danger',
  fatal: 'danger',
} as const

type Column = 'time' | 'level' | 'source' | 'message'

function query(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams()
  if (filters.level !== 'all') params.set('level', filters.level)
  if (filters.source !== 'all') params.set('source', filters.source)
  if (filters.text) params.set('q', filters.text)
  if (cursor) params.set('cursor', cursor)
  const search = params.toString()
  return `/api/admin/diagnostics/logs${search ? `?${search}` : ''}`
}

function isPage(data: unknown): data is DiagnosticsLogPage {
  return typeof data === 'object' && data !== null && Array.isArray((data as DiagnosticsLogPage).entries)
}

/** 结构化字段之外的字段写成 键=值，字符串不加引号 */
function extraFields(record: NonNullable<DiagnosticsLogEntry['record']>): string {
  return Object.entries(record)
    .filter(([key]) => !LOG_RECORD_FIELDS.has(key))
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
}

/**
 * 日志文件里的原样内容，从新到旧（ADR-0062）：筛选级别、来源和关键字，"更早的"接着往下排；一次请求扫满 8 MB
 * 还没凑够一页时写明，让管理员决定要不要继续往前找。只看第一页时每 5 秒取一次新的，翻到更早的就停下，
 * 免得读着读着行被挤走
 */
export function LogViewer({ initial }: { initial: DiagnosticsLogPage }) {
  const t = useTranslations('admin.diagnostics.logs')
  const admin = useTranslations('admin')
  const format = useFormatter()
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [text, setText] = useState('')
  const [page, setPage] = useState({ entries: initial.entries, next: initial.next, scanLimited: initial.scanLimited })
  const [older, setOlder] = useState(false)
  const [loading, setLoading] = useState<'first' | 'older' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollFailed, setPollFailed] = useState(false)
  // 筛选或翻页之后，之前发出去的请求（包括轮询）回来了也不用；筛选和翻页的请求还没回来时不轮询，
  // 翻到更早的以后也不轮询。用 ref 记，定时器在重新渲染之前触发时也看得到
  const generation = useRef(0)
  const busy = useRef(false)
  const paged = useRef(false)

  const load = useCallback(
    async (next: Filters, cursor: string | null) => {
      const current = ++generation.current
      busy.current = true
      setLoading(cursor ? 'older' : 'first')
      setError(null)
      const { status, data } = await getJson(query(next, cursor))
      if (current !== generation.current) return
      busy.current = false
      setLoading(null)
      if (status !== 200 || !isPage(data)) {
        setError(apiError(data)?.message ?? admin('failed'))
        return
      }
      setPollFailed(false)
      paged.current = cursor !== null
      setOlder(cursor !== null)
      setPage((previous) => {
        if (!cursor) return { entries: data.entries, next: data.next, scanLimited: data.scanLimited }
        const seen = new Set(previous.entries.map((entry) => entry.id))
        return {
          entries: [...previous.entries, ...data.entries.filter((entry) => !seen.has(entry.id))],
          next: data.next,
          scanLimited: data.scanLimited,
        }
      })
    },
    [admin],
  )

  useEffect(() => {
    if (older) return
    const timer = setInterval(() => {
      if (document.hidden || busy.current || paged.current) return
      const current = generation.current
      void getJson(query(filters, null)).then(({ status, data }) => {
        if (current !== generation.current || busy.current || paged.current) return
        if (status !== 200 || !isPage(data)) {
          setPollFailed(true)
          return
        }
        setPollFailed(false)
        setPage({ entries: data.entries, next: data.next, scanLimited: data.scanLimited })
      })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [filters, older])

  function change(next: Filters) {
    setFilters(next)
    void load(next, null)
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    change({ ...filters, text: text.trim() })
  }

  const filtered = filters.level !== 'all' || filters.source !== 'all' || filters.text !== ''
  const time = (iso: string) =>
    format.dateTime(new Date(iso), {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
    })

  function row(entry: DiagnosticsLogEntry) {
    const { record } = entry
    if (!record)
      return {
        key: entry.id,
        cells: {
          time: <span className="text-text-muted">—</span>,
          level: <span className="text-text-muted">—</span>,
          source: <span className="text-xs text-text-muted">{t('unparsed')}</span>,
          message: <code className="block font-mono text-xs whitespace-pre-wrap wrap-anywhere">{entry.line}</code>,
        },
      }
    const fields = extraFields(record)
    const known = (LOG_SOURCES as readonly string[]).includes(record.source)
    return {
      key: entry.id,
      cells: {
        time: (
          <time dateTime={record.time} className="font-mono text-xs tabular-nums">
            {time(record.time)}
          </time>
        ),
        level: <Badge tone={LEVEL_TONES[record.level]}>{t(`levels.${record.level}`)}</Badge>,
        source: (
          <span className="flex flex-col">
            <span>{known ? t(`sources.${record.source as Source}`) : record.source}</span>
            {record.plugin && <code className="font-mono text-xs text-text-muted">{record.plugin}</code>}
            {record.raw && <span className="text-xs text-text-muted">{t('raw')}</span>}
          </span>
        ),
        message: (
          <span className="flex min-w-72 flex-col gap-0.5 py-1">
            <code className="font-mono text-sm whitespace-pre-wrap wrap-anywhere">
              {record.area && <span className="text-text-muted">[{record.area}] </span>}
              {record.msg}
            </code>
            {fields && <code className="font-mono text-xs text-text-muted wrap-anywhere">{fields}</code>}
          </span>
        ),
      },
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-36">
            <Select
              size="sm"
              aria-label={t('levelLabel')}
              value={filters.level}
              onValueChange={(level) => change({ ...filters, level })}
              options={[
                { value: 'all', label: t('allLevels') },
                ...LOG_LEVELS.map((level) => ({ value: level, label: t('atLeast', { level: t(`levels.${level}`) }) })),
              ]}
            />
          </div>
          <div className="w-36">
            <Select
              size="sm"
              aria-label={t('sourceLabel')}
              value={filters.source}
              onValueChange={(source) => change({ ...filters, source })}
              options={[
                { value: 'all', label: t('allSources') },
                ...LOG_SOURCES.map((source) => ({ value: source, label: t(`sources.${source}`) })),
              ]}
            />
          </div>
          <form role="search" onSubmit={search} className="flex min-w-0 gap-2 sm:w-80">
            <Input
              type="search"
              size="sm"
              value={text}
              onValueChange={setText}
              aria-label={t('searchLabel')}
              placeholder={t('searchPlaceholder')}
              maxLength={200}
            />
            <Button type="submit" size="sm" loading={loading === 'first'}>
              {t('search')}
            </Button>
          </form>
        </div>
        <div className="flex items-center gap-3 text-sm text-text-muted" aria-live="polite">
          {older ? (
            <Button size="sm" onClick={() => void load(filters, null)}>
              {t('latest')}
            </Button>
          ) : (
            <span>{pollFailed ? t('pollFailed') : t('live')}</span>
          )}
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <Table<Column>
        label={t('tableLabel')}
        empty={filtered ? t('emptyFiltered') : t('empty')}
        columns={[
          { key: 'time', header: t('columns.time'), shrink: true },
          { key: 'level', header: t('columns.level'), shrink: true },
          { key: 'source', header: t('columns.source'), shrink: true },
          { key: 'message', header: t('columns.message') },
        ]}
        rows={page.entries.map(row)}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-pretty text-text-muted">
          {page.scanLimited ? t('scanLimited') : page.next ? t('shown', { count: page.entries.length }) : t('end')}
        </p>
        {page.next && (
          <Button size="sm" loading={loading === 'older'} onClick={() => void load(filters, page.next)}>
            {page.scanLimited ? t('continue') : t('older')}
          </Button>
        )}
      </div>
    </div>
  )
}
