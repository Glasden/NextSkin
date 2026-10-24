import type { UpdateStatus } from '@nextskin/domain'
import { Alert, Badge, Link, Panel } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { settingsHref } from '../settings/setting-text'
import { UpdateCheckButton } from './check-button'
import { OneClickUpgrade } from './one-click'
import { Command, UpgradeSteps } from './upgrade-steps'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.updates')
  return { title: t('title') }
}

const DOCKER_UPGRADE = 'docker compose pull && docker compose up -d'
const BUNDLE_GUIDE = 'https://docs.nextskin.org/guide/install/'

/**
 * 后台的更新页（ADR-0061）：当前版本和部署方式、核心每天检查到的新版本、这种部署方式该怎么升级。
 * 只有超级管理员能进来（updates.manage）。所有部署方式看到的都一样，只有"怎么升级"一节不同
 */
export default async function AdminUpdatesPage() {
  const user = await requireAdmin('/admin/updates', 'updates.manage')
  const { core } = await getServer()
  const [status, t, format] = await Promise.all([
    core.updates.status({ uid: user.uid, ip: null }),
    getTranslations('admin.updates'),
    getFormatter(),
  ])
  const time = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  const source = status.deployment === 'source'
  const { latest, failure, manager } = status
  // 镜像自带 Node，换镜像就换了 Node；发行包用的是服务器上装的那个
  const node = Number(process.versions.node.split('.')[0])
  const nodeTooOld = latest !== null && status.deployment === 'bundle' && latest.minNode > node

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="max-w-3xl text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      {!source && !status.enabled && (
        <Alert tone="warning" title={t('disabledTitle')}>
          <span className="flex flex-wrap items-baseline gap-x-3">
            {t('disabled')}
            <Link render={<NextLink href={settingsHref('advanced')} />}>{t('enable')}</Link>
          </span>
        </Alert>
      )}

      {!source && status.enabled && failure && (
        <Alert tone="warning" title={t('failureTitle')}>
          <span className="flex flex-col gap-1">
            <span>
              {t(`failures.${failure.code}`, {
                time: time(failure.at),
                status: failure.code === 'http' ? failure.status : 0,
              })}
            </span>
            {status.checkedAt && <span className="text-text-muted">{t('failureHint')}</span>}
          </span>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel as="section" gap={4} aria-labelledby="updates-current">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id="updates-current" className="text-sm text-text-muted">
                {t('current')}
              </h2>
              <p className="font-pixel text-pixel-3 text-text tabular-nums">{status.current ?? '—'}</p>
            </div>
            <Badge>{t(`deployments.${status.deployment}`)}</Badge>
          </div>
          {!source && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-sm text-text-muted">
                {status.checkedAt ? t('checkedAt', { time: time(status.checkedAt) }) : t('neverChecked')}
              </p>
              {status.enabled && <UpdateCheckButton />}
            </div>
          )}
        </Panel>

        <LatestPanel status={status} nodeTooOld={nodeTooOld} node={process.versions.node} time={time} />
      </div>

      {manager.available ? (
        <section aria-labelledby="updates-how" className="flex flex-col gap-3">
          <h2 id="updates-how" className="font-pixel text-pixel-1 text-text-muted">
            {t('oneClickTitle')}
          </h2>
          <OneClickUpgrade initial={{ ...status, manager }} />
          <p className="text-sm text-pretty text-text-muted">
            {t('oneClickManual')}{' '}
            <Link href={BUNDLE_GUIDE} target="_blank" rel="noreferrer">
              {t('bundleSteps.guide')}
            </Link>
          </p>
        </section>
      ) : (
        <section aria-labelledby="updates-how" className="flex flex-col gap-3">
          <h2 id="updates-how" className="font-pixel text-pixel-1 text-text-muted">
            {t('how')}
          </h2>
          {status.deployment === 'bundle' && manager.reason === 'unreachable' && (
            <Alert tone="warning" title={t('managerUnreachableTitle')}>
              {t('managerUnreachable')}
            </Alert>
          )}
          {status.deployment === 'bundle' && (manager.reason === 'readonly' || manager.reason === 'unmanaged') && (
            <p className="max-w-3xl text-sm text-pretty text-text-muted">{t(`managerReasons.${manager.reason}`)}</p>
          )}
          <Panel gap={4}>
            {source ? (
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-medium text-text">{t('sourceTitle')}</h3>
                <p className="text-sm text-pretty text-text-muted">{t('source')}</p>
              </div>
            ) : status.deployment === 'docker' ? (
              <UpgradeSteps
                steps={[
                  <p key="backup">{t('dockerSteps.backup')}</p>,
                  <div key="pull" className="flex min-w-0 flex-col gap-2">
                    <p>{t('dockerSteps.pull')}</p>
                    <Command>{DOCKER_UPGRADE}</Command>
                  </div>,
                ]}
                footer={t('dockerSteps.after')}
              />
            ) : (
              <UpgradeSteps
                steps={[
                  <p key="download">{t('bundleSteps.download')}</p>,
                  <p key="stop">{t('bundleSteps.stop')}</p>,
                  <p key="unzip">{t('bundleSteps.unzip')}</p>,
                ]}
                footer={
                  <Link href={BUNDLE_GUIDE} target="_blank" rel="noreferrer">
                    {t('bundleSteps.guide')}
                  </Link>
                }
              />
            )}
          </Panel>
        </section>
      )}

      {!source && <p className="max-w-3xl text-sm text-pretty text-text-muted">{t('privacy')}</p>}
    </div>
  )
}

/** 新版本的一块：有新版本时写版本号、日期和发布说明，没有时说明是已经最新还是还没检查过 */
async function LatestPanel({
  status,
  nodeTooOld,
  node,
  time,
}: {
  status: UpdateStatus
  nodeTooOld: boolean
  node: string
  time: (iso: string) => string
}) {
  const t = await getTranslations('admin.updates')
  const { latest } = status
  if (status.deployment === 'source') return null
  return (
    <Panel as="section" gap={4} aria-labelledby="updates-latest">
      {latest ? (
        <>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="updates-latest" className="text-sm text-text-muted">
              {t('latest')}
            </h2>
            <p className="font-pixel text-pixel-3 text-text tabular-nums">{latest.version}</p>
          </div>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border pt-4 text-sm text-text-muted">
            {t('releasedAt', { date: time(latest.date) })}
            <Link href={latest.notes} target="_blank" rel="noreferrer">
              {t('notes')}
            </Link>
          </p>
          {nodeTooOld && <Alert tone="warning">{t('nodeTooOld', { required: latest.minNode, current: node })}</Alert>}
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <h2 id="updates-latest" className="text-base font-medium text-text">
            {status.checkedAt ? t('upToDate') : t('unknown')}
          </h2>
          <p className="text-sm text-pretty text-text-muted">
            {status.checkedAt ? t('upToDateHint') : t('unknownHint')}
          </p>
        </div>
      )}
    </Panel>
  )
}
