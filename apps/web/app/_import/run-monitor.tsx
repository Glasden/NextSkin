'use client'

import type { ImportRunState, ImportStage } from '@nextskin/importer'
import { Alert, Button, ProgressBar, Steps } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import { apiError, getJson, postJson } from '../../lib/api-client'

const stages: readonly ImportStage[] = [
  'connect',
  'users',
  'textures',
  'players',
  'closet',
  'reports',
  'oauthClients',
  'settings',
  'commit',
]

/** 进度只在服务的内存里（ADR-0031），每秒问一次；认的是运行令牌的 Cookie，不是会话 */
const POLL_MS = 1000

function isRunState(value: unknown): value is ImportRunState {
  return typeof value === 'object' && value !== null && 'status' in value && 'progress' in value
}

/**
 * 一次运行（试跑或导入）的进度：各阶段排成竖排的步骤，当前阶段带进度条；可以取消。
 * 结束后把最终状态（带报告）交给 onFinished
 */
export function RunMonitor({
  initial,
  onFinished,
}: {
  initial: ImportRunState
  onFinished: (state: ImportRunState) => void
}) {
  const t = useTranslations('import.progress')
  const format = useFormatter()
  const [state, setState] = useState(initial)
  const [lost, setLost] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const report = useRef(onFinished)
  useEffect(() => {
    report.current = onFinished
  })

  useEffect(() => {
    if (initial.status !== 'running') {
      report.current(initial)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    async function poll() {
      const { status, data } = await getJson('/api/import/run')
      if (stopped) return
      if (status === 200 && isRunState(data)) {
        setState(data)
        if (data.status !== 'running') {
          report.current(data)
          return
        }
      } else if (status === 404) {
        // 服务重启过：内存里的进度没了，数据库已经回滚了这次运行
        setLost(true)
        return
      }
      timer = setTimeout(() => void poll(), POLL_MS)
    }
    timer = setTimeout(() => void poll(), POLL_MS)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(clock)
    }
  }, [initial])

  async function cancel() {
    setCancelError(null)
    setState((current) => ({ ...current, cancelling: true }))
    const { status, data } = await postJson('/api/import/run/cancel', {})
    if (status === 200 && isRunState(data)) setState(data)
    else if (status !== 409) {
      setState((current) => ({ ...current, cancelling: false }))
      setCancelError(apiError(data)?.message ?? t('cancelFailed'))
    }
  }

  const index = Math.max(0, stages.indexOf(state.progress.stage))
  const elapsed = Math.max(0, Math.floor((now - Date.parse(state.startedAt)) / 1000))
  const { rows, total, files } = state.progress
  const counted = (stage: ImportStage) => stage !== 'connect' && stage !== 'settings' && stage !== 'commit'

  return (
    <section className="flex flex-col gap-6" aria-busy={state.status === 'running'}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-pixel text-pixel-2 text-text">{t(state.dryRun ? 'dryRunTitle' : 'importTitle')}</h2>
          <p className="text-sm text-text-muted tabular-nums">
            {t('elapsed', { minutes: Math.floor(elapsed / 60), seconds: String(elapsed % 60).padStart(2, '0') })}
          </p>
        </div>
        {state.status === 'running' && !lost && (
          <Button onClick={() => void cancel()} loading={state.cancelling}>
            {t(state.dryRun ? 'cancelDryRun' : 'cancelImport')}
          </Button>
        )}
      </header>

      {lost ? (
        <Alert tone="warning" title={t('lostTitle')}>
          {t('lost')}
        </Alert>
      ) : (
        <Alert title={t('maintenanceTitle')}>{t('maintenance')}</Alert>
      )}
      {cancelError && <Alert tone="danger">{cancelError}</Alert>}

      <div className="rounded-md border border-border bg-surface p-4 sm:p-6">
        <Steps
          label={t('stagesLabel')}
          orientation="vertical"
          completeLabel={t('complete')}
          current={index}
          items={stages.map((stage, position) => ({
            label: t(`stages.${stage}`),
            description:
              position === index && state.status === 'running' ? (
                counted(stage) ? (
                  <div className="flex flex-col gap-2">
                    <ProgressBar
                      label={t('processed')}
                      value={total === null ? null : rows}
                      max={total ?? undefined}
                      valueText={
                        total === null
                          ? t('rows', { rows: format.number(rows) })
                          : t('rowsOf', { rows: format.number(rows), total: format.number(total) })
                      }
                    />
                    {stage === 'textures' && <span>{t('files', { count: files })}</span>}
                  </div>
                ) : (
                  <ProgressBar label={t(`stageHints.${stage}`)} value={null} />
                )
              ) : undefined,
          }))}
        />
      </div>
    </section>
  )
}
