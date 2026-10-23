'use client'

import type { ImportCheckResult, ImportEnvForm, ImportRunState, ImportSourceDefaults } from '@nextskin/importer'
import { Alert, Button, Checkbox, Field, FileDrop, Form, Input, Steps, Textarea } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'
import { apiError, formErrors, postJson, type ApiError } from '../../lib/api-client'
import { RunResult } from './run-panel'
import { RunMonitor } from './run-monitor'
import { CheckResult, emptySource, SourceFields, sourcePayload, type SourceValues } from './source-form'

const steps = ['env', 'source', 'dryRun', 'confirm', 'import', 'done'] as const
type Step = (typeof steps)[number]

/** .env 太大时不读：phpdotenv 的文件一般只有几 KB，接口也只收 16 KB */
const MAX_ENV_BYTES = 16 * 1024

function fromDefaults(defaults: ImportSourceDefaults | null): SourceValues {
  if (!defaults) return emptySource
  const { connection } = defaults
  return {
    ...emptySource,
    ...(connection.dialect === 'sqlite'
      ? { dialect: 'sqlite', file: connection.file, port: '' }
      : {
          dialect: connection.dialect,
          host: connection.host,
          port: String(connection.port),
          database: connection.database,
          username: connection.username,
        }),
    prefix: defaults.prefix,
    texturesDirectory: defaults.texturesDirectory,
    timeZone: defaults.timeZone,
  }
}

function runOf(data: unknown): ImportRunState | null {
  return typeof data === 'object' && data !== null && 'run' in data ? (data as { run: ImportRunState }).run : null
}

/**
 * 从 BS 导入的步骤（ADR-0031），安装向导和后台的“数据迁移”共用：旧站的 .env → 连接和路径（检查）→ 试跑 → 确认 → 导入 → 完成。
 * base 是接口的前缀：安装向导认安装码的 Cookie，后台认会话和“数据迁移”权限；进度和取消都认运行令牌的 Cookie
 */
export function ImportWizard({
  base,
  defaults,
  siteUrl: defaultSiteUrl,
  leave,
}: {
  base: '/api/setup/import' | '/api/admin/import'
  /** 上一次运行的非机密项（后台）；数据库密码和盐每次重新输入 */
  defaults: ImportSourceDefaults | null
  /** 当前访问的地址，确认这一步的站点地址默认用它 */
  siteUrl: string
  /** 第一步上的“换一种方式”（安装向导回到选择新站还是导入） */
  leave?: { label: string; onLeave: () => void }
}) {
  const t = useTranslations('import.wizard')
  const common = useTranslations('common')
  const [step, setStep] = useState<Step>('env')
  const [source, setSource] = useState<SourceValues>(() => fromDefaults(defaults))
  const [nonLocal, setNonLocal] = useState(false)
  const [check, setCheck] = useState<ImportCheckResult | null>(null)
  const [run, setRun] = useState<ImportRunState | null>(null)
  const [dryRun, setDryRun] = useState<ImportRunState | null>(null)
  const [final, setFinal] = useState<ImportRunState | null>(null)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [siteUrl, setSiteUrl] = useState(defaultSiteUrl)
  const [replace, setReplace] = useState(false)
  const [force, setForce] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const index = steps.indexOf(step)
  const current = step === 'done' && final?.status === 'succeeded' ? steps.length : index

  function go(next: Step) {
    setError(null)
    setErrors({})
    setStep(next)
  }

  function fail(failure: ApiError | null, fallback: string) {
    if (failure?.fields) {
      setErrors(formErrors(failure))
      setError(failure.message)
    } else setError(failure?.message ?? fallback)
  }

  function changeSource(values: SourceValues) {
    setSource(values)
    // 改了连接或路径，上一次的检查和试跑就不算数了
    setCheck(null)
    setDryRun(null)
  }

  async function readEnv(text: string, directory: string) {
    setPending(true)
    setError(null)
    const { status, data } = await postJson(`${base}/env`, { text, directory: directory.trim() || null })
    setPending(false)
    if (status !== 200 || !data) return fail(apiError(data), t('failed'))
    const env = data as ImportEnvForm
    const connection = env.connection
    changeSource({
      ...source,
      ...(connection
        ? connection.dialect === 'sqlite'
          ? { dialect: 'sqlite', file: connection.file, port: '' }
          : {
              dialect: connection.dialect,
              host: connection.host,
              port: String(connection.port),
              database: connection.database,
              username: connection.username,
              password: connection.password,
            }
        : {}),
      prefix: env.prefix,
      passwordMethod: env.passwordMethod ?? '',
      salt: env.salt,
      texturesDirectory: env.texturesDirectory ?? source.texturesDirectory,
    })
    setNonLocal(!env.localTextures)
    go('source')
  }

  async function runCheck() {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson(`${base}/check`, sourcePayload(source))
    setPending(false)
    if (status === 200 && data) setCheck(data as ImportCheckResult)
    else fail(apiError(data), t('failed'))
  }

  async function start(dry: boolean) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson(`${base}/runs`, {
      ...sourcePayload(source),
      dryRun: dry,
      siteUrl: siteUrl.trim() || null,
      uuidOverrides: choices,
      // 试跑不管目标库里有没有数据：要删什么列在报告的“目标库”里，到确认这一步再勾选
      replace: dry || replace,
      force: dry || force,
    })
    setPending(false)
    const started = status === 202 ? runOf(data) : null
    if (!started) {
      const failure = apiError(data)
      // 字段错误都出在连接和路径上：回到那一步显示
      if (failure?.fields && dry) {
        setStep('source')
        setErrors(formErrors(failure))
        setError(failure.message)
        return
      }
      return fail(failure, t('failed'))
    }
    setRun(started)
    if (!dry) go('import')
  }

  const ready = check?.database.status === 'ok' && check.textures.readable
  const target = dryRun?.report?.target
  const hasData = target ? target.newData !== null : false
  const fresh =
    target !== undefined &&
    hasData &&
    (target.lastImportAt === null || Object.values(target.newData ?? {}).some((count) => count > 0))
  const dryReady = dryRun?.status === 'succeeded'

  return (
    <div className="flex flex-col gap-8">
      <Steps
        label={t('stepsLabel')}
        completeLabel={t('complete')}
        current={current}
        items={steps.map((value) => ({ label: t(`steps.${value}`) }))}
      />

      {error && step !== 'source' && <Alert tone="danger">{error}</Alert>}

      {step === 'env' && <EnvStep pending={pending} onRead={readEnv} onSkip={() => go('source')} leave={leave} />}

      {step === 'source' && (
        <Panel title={t('source.title')} description={t('source.description')}>
          <Form errors={errors} onFormSubmit={() => void runCheck()}>
            {error && <Alert tone="danger">{error}</Alert>}
            {nonLocal && (
              <Alert tone="warning" title={t('source.nonLocalTitle')}>
                {t('source.nonLocal')}
              </Alert>
            )}
            <SourceFields values={source} onChange={changeSource} />
            {check && <CheckResult result={check} />}
            <div className="flex flex-wrap gap-3">
              <Button type="button" onClick={() => go('env')}>
                {t('back')}
              </Button>
              <Button type="submit" variant={ready ? 'secondary' : 'primary'} loading={pending}>
                {t(check ? 'source.recheck' : 'source.check')}
              </Button>
              {ready && (
                <Button type="button" variant="primary" onClick={() => go('dryRun')}>
                  {t('source.next')}
                </Button>
              )}
            </div>
          </Form>
        </Panel>
      )}

      {step === 'dryRun' &&
        (run?.status === 'running' ? (
          <RunMonitor
            initial={run}
            onFinished={(state) => {
              setRun(null)
              setDryRun(state)
            }}
          />
        ) : dryRun ? (
          <RunResult
            state={dryRun}
            choices={{
              selected: choices,
              onSelect: (pid, uuid) =>
                setChoices((current) => {
                  const next = { ...current }
                  if (uuid) next[String(pid)] = uuid
                  else delete next[String(pid)]
                  return next
                }),
            }}
          >
            <Button onClick={() => go('source')}>{t('back')}</Button>
            <Button variant={dryReady ? 'secondary' : 'primary'} loading={pending} onClick={() => void start(true)}>
              {t('dryRun.again')}
            </Button>
            {dryReady && (
              <Button variant="primary" onClick={() => go('confirm')}>
                {t('dryRun.next')}
              </Button>
            )}
          </RunResult>
        ) : (
          <Panel title={t('dryRun.title')} description={t('dryRun.description')}>
            <Alert title={t('dryRun.maintenanceTitle')}>{t('dryRun.maintenance')}</Alert>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => go('source')}>{t('back')}</Button>
              <Button variant="primary" loading={pending} onClick={() => void start(true)}>
                {t('dryRun.start')}
              </Button>
            </div>
          </Panel>
        ))}

      {step === 'confirm' && dryRun && (
        <Panel title={t('confirm.title')} description={t('confirm.description')}>
          <Form errors={errors} onFormSubmit={() => void start(false)}>
            <Field
              label={t('confirm.siteUrl')}
              name="siteUrl"
              description={t('confirm.siteUrlHint')}
              formatError={common('urlFormat')}
            >
              <Input type="url" value={siteUrl} onValueChange={setSiteUrl} required />
            </Field>
            {hasData && target && (
              <Alert tone="warning" title={t('confirm.replaceTitle')}>
                <div className="flex flex-col gap-3">
                  <p>{t('confirm.replaceHint', { ...target.before })}</p>
                  <Checkbox checked={replace} onCheckedChange={setReplace}>
                    {t('confirm.replace')}
                  </Checkbox>
                  {fresh && (
                    <>
                      <p>{t(target.lastImportAt === null ? 'confirm.neverImported' : 'confirm.newData')}</p>
                      <Checkbox checked={force} onCheckedChange={setForce}>
                        {t('confirm.force')}
                      </Checkbox>
                    </>
                  )}
                </div>
              </Alert>
            )}
            <Alert title={t('confirm.notesTitle')}>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                <li>{t('confirm.noteDuration', { seconds: durationOf(dryRun) })}</li>
                <li>{t('confirm.noteSignIn')}</li>
                <li>{t('confirm.noteSingleInstance')}</li>
              </ul>
            </Alert>
            <div className="flex flex-wrap gap-3">
              <Button type="button" onClick={() => go('dryRun')}>
                {t('back')}
              </Button>
              <Button
                type="submit"
                // 站点里有数据时，导入会把它们替换掉：按不可逆操作处理
                variant={hasData ? 'danger' : 'primary'}
                loading={pending}
                disabled={(hasData && !replace) || (fresh && !force)}
              >
                {t('confirm.start')}
              </Button>
            </div>
          </Form>
        </Panel>
      )}

      {step === 'import' && run && (
        <RunMonitor
          initial={run}
          onFinished={(state) => {
            setRun(null)
            setFinal(state)
            go('done')
          }}
        />
      )}

      {step === 'done' && final && (
        <RunResult state={final}>
          {final.status !== 'succeeded' && (
            <Button
              onClick={() => {
                setDryRun(null)
                go('dryRun')
              }}
            >
              {t('done.retry')}
            </Button>
          )}
        </RunResult>
      )}
    </div>
  )
}

function durationOf(state: ImportRunState): number {
  const end = state.finishedAt ? Date.parse(state.finishedAt) : Date.now()
  return Math.max(1, Math.round((end - Date.parse(state.startedAt)) / 1000))
}

function Panel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-pixel text-pixel-2 text-text">{title}</h2>
        <p className="text-sm text-pretty text-text-muted">{description}</p>
      </header>
      {children}
    </section>
  )
}

/** 第一步：上传或粘贴旧站的 .env。没有也可以跳过，下一步手动填 */
function EnvStep({
  pending,
  onRead,
  onSkip,
  leave,
}: {
  pending: boolean
  onRead: (text: string, directory: string) => Promise<void>
  onSkip: () => void
  leave?: { label: string; onLeave: () => void }
}) {
  const t = useTranslations('import.wizard.env')
  const format = useFormatter()
  const [text, setText] = useState('')
  const [directory, setDirectory] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)

  async function pick(file: File) {
    setFileError(null)
    if (file.size > MAX_ENV_BYTES) {
      setFileError(t('tooLarge', { max: format.number(MAX_ENV_BYTES / 1024) }))
      return
    }
    setText(await file.text())
  }

  return (
    <Panel title={t('title')} description={t('description')}>
      <Form onFormSubmit={() => void onRead(text, directory)}>
        <FileDrop
          title={t('dropTitle')}
          description={t('dropDescription')}
          buttonLabel={t('choose')}
          error={fileError}
          onFile={(file) => void pick(file)}
        />
        <Field label={t('paste')} name="text" description={t('privacy')}>
          <Textarea
            value={text}
            onValueChange={setText}
            rows={8}
            maxLength={MAX_ENV_BYTES}
            placeholder={'DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\n…'}
          />
        </Field>
        <Field label={t('directory')} name="directory" description={t('directoryHint')}>
          <Input value={directory} onValueChange={setDirectory} placeholder="/srv/blessing-skin" />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="primary" loading={pending} disabled={!text.trim()}>
            {t('read')}
          </Button>
          <Button type="button" onClick={onSkip}>
            {t('skip')}
          </Button>
          {leave && (
            <Button type="button" onClick={leave.onLeave}>
              {leave.label}
            </Button>
          )}
        </div>
      </Form>
    </Panel>
  )
}
