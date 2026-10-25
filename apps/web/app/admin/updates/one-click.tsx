'use client'

import type { ManagerStatus, UpdateStatus } from '@nextskin/domain'
import { Alert, Button, Checkbox, Dialog, DialogClose, Link, Panel, ProgressBar, Steps, useToast } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { apiError, getJson, sendJson } from '../../../lib/api-client'
import { Command, UpgradeSteps } from './upgrade-steps'

/** 准备阶段的步骤，名字和管理进程报的 step 一致（ADR-0061"升级的流水线"1–5） */
const PREPARE_STEPS = ['manifest', 'space', 'download', 'extract', 'preflight'] as const
/** 准备时每秒问一次；切换时核心会停掉，问得慢一点，连不上就接着问 */
const PREPARE_POLL_MS = 1000
const SWITCH_POLL_MS = 2000
/** 停站、迁移、启动加健康检查最多两分多钟，过了五分钟还没回来就让管理员去服务器上看 */
const SWITCH_PATIENCE_MS = 5 * 60_000
const ROLLBACK_COMMAND = 'node nextskin.mjs rollback --yes'
const ROLLBACK_GUIDE = 'https://docs.nextskin.org/guide/commands/#rollback'

type Managed = ManagerStatus & { available: true }
/**
 * since 是页面的时钟，只用来算等了多久；判断切换结束看 after：管理进程报出的结果和开始前的不一样了。
 * 不拿结果的时间和 since 比：服务器的钟和浏览器的可能差一两秒，回滚的结果记的又是开始时间
 */
type Switching = { kind: 'apply' | 'rollback'; version: string; since: number; after: string | null }
const resultKey = (result: ManagerStatus['lastResult']) => (result ? JSON.stringify(result) : null)

function isStatus(value: unknown): value is UpdateStatus {
  return typeof value === 'object' && value !== null && 'manager' in value && 'deployment' in value
}

/**
 * 一键升级（ADR-0061）：准备（下载、校验、解压、预检，站点照常）→ 看预检结果 → 确认后切换；也能回到上一个版本。
 * 进度只在管理进程里，页面轮询 GET /api/admin/updates。切换时发请求的核心会被停掉，页面等新的核心起来、
 * 读到这次的结果再刷新
 */
export function OneClickUpgrade({ initial }: { initial: UpdateStatus & { manager: Managed } }) {
  const t = useTranslations('admin.updates.oneClick')
  const admin = useTranslations('admin')
  const format = useFormatter()
  const router = useRouter()
  const toast = useToast()
  const [status, setStatus] = useState(initial)
  // 点"检查更新"后 router.refresh() 送来服务端的新状态，换上它，不然查到了新版本这里还是"已经是最新版本"
  const [previous, setPrevious] = useState(initial)
  if (previous !== initial) {
    setPrevious(initial)
    setStatus(initial)
  }
  const [switching, setSwitching] = useState<Switching | null>(() => {
    const operation = initial.manager.operation
    // 打开页面时操作已经在进行，现有的结果是之前的，操作结束后报出的就是这次的
    return operation && operation.kind !== 'prepare'
      ? { kind: operation.kind, version: operation.version ?? '', since: Date.parse(operation.startedAt), after: null }
      : null
  })
  const [lost, setLost] = useState(false)
  const [sending, setSending] = useState<'prepare' | 'cancel' | null>(null)
  const refresh = useRef(() => router.refresh())
  useEffect(() => {
    refresh.current = () => router.refresh()
  })

  const manager = status.manager.available ? status.manager : null
  const preparing = manager?.operation?.kind === 'prepare'

  // 准备时每秒刷新进度；准备结束（有了 prepared 或失败结果）就停
  useEffect(() => {
    if (!preparing) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      const { status: code, data } = await getJson('/api/admin/updates')
      if (stopped) return
      if (code === 200 && isStatus(data)) {
        setStatus((current) => ({ ...current, ...data }) as typeof current)
        if (!data.manager.available || data.manager.operation?.kind !== 'prepare') return
      }
      timer = setTimeout(() => void poll(), PREPARE_POLL_MS)
    }
    timer = setTimeout(() => void poll(), PREPARE_POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [preparing])

  // 切换时：核心停掉的这段时间请求失败是正常的，等新起来的核心报出这次之后的结果
  useEffect(() => {
    if (!switching) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      const { status: code, data } = await getJson('/api/admin/updates')
      if (stopped) return
      if (code === 200 && isStatus(data) && data.manager.available) {
        const { operation, lastResult } = data.manager
        if (!operation && lastResult && resultKey(lastResult) !== switching!.after) {
          setStatus((current) => ({ ...current, ...data }) as typeof current)
          setSwitching(null)
          refresh.current()
          return
        }
      }
      if (Date.now() - switching!.since > SWITCH_PATIENCE_MS) setLost(true)
      timer = setTimeout(() => void poll(), SWITCH_POLL_MS)
    }
    timer = setTimeout(() => void poll(), SWITCH_POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [switching])

  async function prepare(version: string) {
    setSending('prepare')
    const { status: code, data } = await sendJson('POST', '/api/admin/updates/prepare', { version })
    if (code === 200) {
      // 管理进程在后台开始了，立刻读一次让进度出来
      const latest = await getJson('/api/admin/updates')
      if (latest.status === 200 && isStatus(latest.data)) setStatus(latest.data as typeof status)
    } else toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
    setSending(null)
  }

  async function cancel() {
    setSending('cancel')
    const { status: code, data } = await sendJson('POST', '/api/admin/updates/cancel')
    if (code !== 200) toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
    setSending(null)
  }

  /** apply 和 rollback 被接受后不等结果：管理进程接着就停掉了这个核心 */
  async function start(kind: Switching['kind'], version: string, body: object): Promise<boolean> {
    const since = Date.now()
    const after = resultKey(manager?.lastResult ?? null)
    const { status: code, data } = await sendJson('POST', `/api/admin/updates/${kind}`, body)
    if (code !== 200) {
      toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
      return false
    }
    setLost(false)
    setSwitching({ kind, version, since, after })
    return true
  }

  if (!manager) return null
  const { latest } = status
  // 目标是在用的管理进程升得了的最新版本；最新的要更新的管理进程时，先升到它、重启一次再升（ADR-0061）
  const target = manager.prepared?.version ?? status.target?.version ?? null
  const megabytes = (bytes: number) => format.number(bytes / 1024 / 1024, { maximumFractionDigits: 1 })

  return (
    <div className="flex flex-col gap-4">
      {!switching && manager.lastResult && <LastResult result={manager.lastResult} />}

      <Panel gap={4} aria-busy={preparing || !!switching}>
        {switching ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-medium text-text">
                {t(switching.kind === 'apply' ? 'switchingTitle' : 'rollingBackTitle', { version: switching.version })}
              </h3>
              <p className="text-sm text-pretty text-text-muted">{t('switching')}</p>
            </div>
            <ProgressBar label={t('switchingProgress')} value={null} />
            {lost && (
              <Alert tone="warning" title={t('lostTitle')}>
                {t('lost')}
              </Alert>
            )}
          </div>
        ) : preparing && manager.operation ? (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h3 className="text-base font-medium text-text">
                {t('preparingTitle', { version: manager.operation.version ?? '' })}
              </h3>
              <Button size="sm" loading={sending === 'cancel'} onClick={() => void cancel()}>
                {t('cancel')}
              </Button>
            </div>
            <Steps
              label={t('stepsLabel')}
              orientation="vertical"
              completeLabel={t('complete')}
              current={Math.max(0, PREPARE_STEPS.indexOf(manager.operation.step as (typeof PREPARE_STEPS)[number]))}
              items={PREPARE_STEPS.map((step) => ({
                label: t(`steps.${step}`),
                description:
                  step === manager.operation?.step ? (
                    step === 'download' && manager.operation.progress ? (
                      <ProgressBar
                        label={t('downloading')}
                        value={manager.operation.progress.received}
                        max={manager.operation.progress.total}
                        valueText={t('megabytes', {
                          received: megabytes(manager.operation.progress.received),
                          total: megabytes(manager.operation.progress.total),
                        })}
                      />
                    ) : (
                      <ProgressBar label={t(`stepHints.${step}`)} value={null} />
                    )
                  ) : undefined,
              }))}
            />
          </div>
        ) : manager.prepared ? (
          <Prepared
            prepared={manager.prepared}
            current={manager.current}
            onApply={(backupConfirmed) =>
              start('apply', manager.prepared!.version, { version: manager.prepared!.version, backupConfirmed })
            }
          />
        ) : target ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-medium text-text">{t('readyTitle', { version: target })}</h3>
              <p className="text-sm text-pretty text-text-muted">{t('ready')}</p>
              {manager.failed.includes(target) && (
                <p className="text-sm text-pretty text-text-muted">{t('failedBefore')}</p>
              )}
            </div>
            {latest && latest.version !== target && (
              <Alert tone="info" title={t('steppingTitle', { latest: latest.version })}>
                {t('stepping', { target, latest: latest.version })}
              </Alert>
            )}
            <div>
              <Button variant="primary" loading={sending === 'prepare'} onClick={() => void prepare(target)}>
                {t('prepare', { version: target })}
              </Button>
            </div>
          </div>
        ) : latest ? (
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-medium text-text">
              {t('managerOutdatedTitle', { version: latest.version })}
            </h3>
            <p className="text-sm text-pretty text-text-muted">
              {t(manager.pendingManager ? 'managerPending' : 'managerUnzip', { version: latest.version })}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-medium text-text">
              {t(status.checkedAt ? 'nothingTitle' : 'uncheckedTitle')}
            </h3>
            <p className="text-sm text-pretty text-text-muted">{t('nothing')}</p>
          </div>
        )}
      </Panel>

      {!switching && !manager.operation && manager.rollback && (
        <Rollback
          rollback={manager.rollback}
          current={manager.current}
          onRollback={(confirmed) => start('rollback', manager.rollback!.version, { confirmed })}
        />
      )}
    </div>
  )
}

/** 最近一次升级、手动解压或回滚的结果。失败和回滚了的醒目一些，成功的只写一行 */
function LastResult({ result }: { result: NonNullable<ManagerStatus['lastResult']> }) {
  const t = useTranslations('admin.updates.oneClick')
  const format = useFormatter()
  const time = format.dateTime(new Date(result.at), { dateStyle: 'medium', timeStyle: 'short' })
  const values = { from: result.from ?? '—', to: result.to, time }
  if (result.result === 'success')
    return (
      <p className="text-sm text-text-muted">
        {t(result.kind === 'rollback' ? 'lastRollback' : 'lastSuccess', values)}
      </p>
    )
  return (
    <Alert
      tone={result.result === 'failed' ? 'danger' : 'warning'}
      title={t(
        result.kind === 'rollback'
          ? 'lastRollbackFailedTitle'
          : result.result === 'failed'
            ? 'lastFailedTitle'
            : 'lastRolledBackTitle',
        values,
      )}
    >
      <span className="flex flex-col gap-1">
        {result.reason && <span>{result.reason}</span>}
        <span className="text-text-muted">{t('lastHint', { time })}</span>
      </span>
    </Alert>
  )
}

/** 准备好了：预检的结果、这一档失败时会怎样，确认后切换 */
function Prepared({
  prepared,
  current,
  onApply,
}: {
  prepared: NonNullable<ManagerStatus['prepared']>
  current: string
  onApply: (backupConfirmed: boolean) => Promise<boolean>
}) {
  const t = useTranslations('admin.updates.oneClick')
  const [open, setOpen] = useState(false)
  const [backedUp, setBackedUp] = useState(false)
  const [sending, setSending] = useState(false)
  const { preflight, version } = prepared
  const external = preflight.tier === 'external-backup'
  const migrations = preflight.pendingCore + preflight.pendingPlugins

  async function apply() {
    setSending(true)
    const accepted = await onApply(external && backedUp)
    setSending(false)
    if (accepted) setOpen(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-text">{t('preparedTitle', { version })}</h3>
        <p className="text-sm text-pretty text-text-muted">{t('prepared', { current })}</p>
      </div>
      <dl className="grid gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-2">
        <Fact label={t('database')}>{t(`dialects.${preflight.dialect}`)}</Fact>
        <Fact label={t('migrations')}>
          {migrations === 0
            ? t('noMigrations')
            : t('migrationCount', { core: preflight.pendingCore, plugins: preflight.pendingPlugins })}
        </Fact>
        <Fact label={t('downtime')}>{t('downtimeValue')}</Fact>
        <Fact label={t('onFailure')}>{t(`tiers.${preflight.tier}`)}</Fact>
      </dl>
      {preflight.incompatiblePlugins.length > 0 && (
        <Alert tone="warning" title={t('incompatibleTitle')}>
          <span className="flex flex-col gap-1">
            <span>{t('incompatible')}</span>
            <span className="font-mono">
              {preflight.incompatiblePlugins.map((plugin) => `${plugin.id}（${plugin.api}）`).join('、')}
            </span>
          </span>
        </Alert>
      )}
      {external && (
        <Alert tone="warning" title={t('backupTitle')}>
          {t('backup', { dialect: t(`dialects.${preflight.dialect}`) })}
        </Alert>
      )}
      <div>
        <Dialog
          alert
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) setBackedUp(false)
          }}
          trigger={<Button variant="primary">{t('apply', { version })}</Button>}
          title={t('applyTitle', { version })}
          description={t('applyDescription')}
          actions={
            <>
              <DialogClose>{t('cancelApply')}</DialogClose>
              <Button variant="primary" loading={sending} disabled={external && !backedUp} onClick={() => void apply()}>
                {t('apply', { version })}
              </Button>
            </>
          }
        >
          {external && (
            <Checkbox checked={backedUp} onCheckedChange={(checked) => setBackedUp(checked)}>
              {t('backupConfirm', { dialect: t(`dialects.${preflight.dialect}`) })}
            </Checkbox>
          )}
        </Dialog>
      </div>
    </div>
  )
}

/** 预检结果的一项 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="text-sm text-pretty text-text">{children}</dd>
    </div>
  )
}

/**
 * 回到上一个版本（ADR-0061"回滚"）：要确认什么取决于那次升级有没有迁移、用的什么库。
 * MySQL、PostgreSQL 有迁移时不能在线回滚（恢复库的时候新版本还在写库），只写出停着服务做的步骤
 */
function Rollback({
  rollback,
  current,
  onRollback,
}: {
  rollback: NonNullable<ManagerStatus['rollback']>
  current: string
  onRollback: (confirmed: boolean) => Promise<boolean>
}) {
  const t = useTranslations('admin.updates.oneClick')
  const [open, setOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [sending, setSending] = useState(false)
  const sqlite = rollback.dialect === 'sqlite'
  const kind = !rollback.migrations ? 'plain' : sqlite ? 'sqlite' : 'external'
  const blocked = kind === 'sqlite' && !rollback.backupAvailable
  const values = {
    version: rollback.version,
    current,
    dialect: rollback.dialect ? t(`dialects.${rollback.dialect}`) : '',
  }

  async function send() {
    setSending(true)
    // 没有迁移时对话框本身就是确认
    const accepted = await onRollback(kind === 'plain' || confirmed)
    setSending(false)
    if (accepted) setOpen(false)
  }

  return (
    <Panel as="section" gap={4} aria-labelledby="updates-rollback">
      <div className="flex flex-col gap-1">
        <h3 id="updates-rollback" className="text-base font-medium text-text">
          {t('rollbackTitle', values)}
        </h3>
        <p className="text-sm text-pretty text-text-muted">
          {blocked ? t('rollbackBlocked') : t(`rollbackHints.${kind}`, values)}
        </p>
      </div>
      {kind === 'external' ? (
        <UpgradeSteps
          steps={[
            <p key="stop">{t('rollbackSteps.stop')}</p>,
            <p key="restore">{t('rollbackSteps.restore', values)}</p>,
            <div key="command" className="flex min-w-0 flex-col gap-2">
              <p>{t('rollbackSteps.command', values)}</p>
              <Command>{ROLLBACK_COMMAND}</Command>
            </div>,
            <p key="start">{t('rollbackSteps.start', values)}</p>,
          ]}
          footer={
            <Link href={ROLLBACK_GUIDE} target="_blank" rel="noreferrer">
              {t('rollbackSteps.guide')}
            </Link>
          }
        />
      ) : (
        !blocked && (
          <div>
            <Dialog
              alert
              open={open}
              onOpenChange={(next) => {
                setOpen(next)
                if (!next) setConfirmed(false)
              }}
              trigger={<Button variant="danger">{t('rollback', values)}</Button>}
              title={t('rollbackDialogTitle', values)}
              description={t(`rollbackWarnings.${kind}`, values)}
              actions={
                <>
                  <DialogClose>{t('cancelApply')}</DialogClose>
                  <Button
                    variant="danger"
                    loading={sending}
                    disabled={kind === 'sqlite' && !confirmed}
                    onClick={() => void send()}
                  >
                    {t('rollback', values)}
                  </Button>
                </>
              }
            >
              {kind === 'sqlite' && (
                <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked)}>
                  {t('rollbackConfirms.sqlite')}
                </Checkbox>
              )}
            </Dialog>
          </div>
        )
      )}
    </Panel>
  )
}
