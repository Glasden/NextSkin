'use client'

import type { ImportRunState } from '@nextskin/importer'
import { Alert, Link } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useState, type ReactNode } from 'react'
import { ReportView } from './report-view'
import { RunMonitor } from './run-monitor'

/**
 * 维护页上发起人看到的这次运行：进行中显示进度，结束后显示结果和报告。
 * 发起人可能刷新过页面、换过地址，向导的状态没了，这里只给出结果和下一步去哪
 */
export function RunPanel({ initial }: { initial: ImportRunState }) {
  const t = useTranslations('import.result')
  const [state, setState] = useState(initial)
  if (state.status === 'running') return <RunMonitor initial={state} onFinished={setState} />
  const back = state.entry === 'setup' ? '/setup' : '/admin/migration'
  return (
    <RunResult state={state}>
      {!(state.status === 'succeeded' && !state.dryRun) && (
        <Link render={<NextLink href={back} />}>{t(state.entry === 'setup' ? 'backToSetup' : 'backToMigration')}</Link>
      )}
    </RunResult>
  )
}

/** 一次运行的结果：标题、导入成功后的登录提示、下载报告，以及报告本身。children 是页面自己的下一步操作 */
export function RunResult({
  state,
  choices,
  children,
}: {
  state: ImportRunState
  choices?: Parameters<typeof ReportView>[0]['choices']
  children?: ReactNode
}) {
  const t = useTranslations('import.result')
  const imported = state.status === 'succeeded' && !state.dryRun
  const title =
    state.status === 'succeeded'
      ? t(state.dryRun ? 'dryRunSucceeded' : 'importSucceeded')
      : t(`titles.${state.status === 'running' ? 'failed' : state.status}`)
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-pixel text-pixel-2 text-text">{title}</h2>
        <p className="text-sm text-pretty text-text-muted">
          {state.status === 'succeeded'
            ? t(state.dryRun ? 'dryRunSucceededHint' : 'importSucceededHint')
            : t(`hints.${state.status === 'running' ? 'failed' : state.status}`)}
        </p>
      </header>
      {imported && (
        <Alert tone="success" title={t('signInTitle')}>
          <span className="flex flex-wrap items-baseline gap-x-3">
            {t('signIn')}
            <Link render={<NextLink href="/sign-in" />}>{t('signInAction')}</Link>
          </span>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {children}
        {state.report && (
          // 认运行令牌的 Cookie：导入之后发起人的会话已经不在了
          <Link href="/api/import/run/report.md" download>
            {t('download')}
          </Link>
        )}
      </div>
      {state.report && (
        <ReportView
          report={state.report}
          status={state.status === 'running' ? 'failed' : state.status}
          choices={choices}
        />
      )}
      {!state.report && <Alert tone="danger">{t('noReport')}</Alert>}
    </section>
  )
}
