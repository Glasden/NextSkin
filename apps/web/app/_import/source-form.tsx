'use client'

import type { ImportCheckResult } from '@nextskin/importer'
import { Alert, Field, Input, SegmentedControl, Select } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'

/** 表单里的旧库和旧站：数据库密码和盐只在浏览器和这次运行的内存里，不写进 import_runs（ADR-0031） */
export interface SourceValues {
  dialect: 'mysql' | 'postgres' | 'sqlite'
  host: string
  port: string
  database: string
  username: string
  password: string
  file: string
  prefix: string
  texturesDirectory: string
  timeZone: string
  /** 空串：不知道（没有 .env），按 BS 的默认 BCRYPT */
  passwordMethod: string
  salt: string
}

export const emptySource: SourceValues = {
  dialect: 'mysql',
  host: '127.0.0.1',
  port: '3306',
  database: '',
  username: '',
  password: '',
  file: '',
  prefix: '',
  texturesDirectory: '',
  timeZone: 'Asia/Shanghai',
  passwordMethod: '',
  salt: '',
}

/** BS 的 PWD_METHOD（config/secure.php），和导入器认的一致 */
const passwordMethods = [
  'BCRYPT',
  'ARGON2I',
  'PHP_PASSWORD_HASH',
  'MD5',
  'SALTED2MD5',
  'SHA256',
  'SALTED2SHA256',
  'SHA512',
  'SALTED2SHA512',
] as const

const defaultPorts = { mysql: '3306', postgres: '5432', sqlite: '' } as const

/** 请求体里的旧库和旧站（ImportSourceInput） */
export function sourcePayload(values: SourceValues) {
  return {
    connection:
      values.dialect === 'sqlite'
        ? { dialect: 'sqlite' as const, file: values.file.trim() }
        : {
            dialect: values.dialect,
            host: values.host.trim(),
            port: Number(values.port),
            database: values.database.trim(),
            username: values.username.trim(),
            password: values.password,
          },
    prefix: values.prefix.trim(),
    texturesDirectory: values.texturesDirectory.trim(),
    timeZone: values.timeZone.trim(),
    passwordMethod: values.passwordMethod || null,
    salt: values.salt,
  }
}

/** 旧库的连接、材质目录、时区和密码算法。值由向导保存，回到这一步时还在 */
export function SourceFields({ values, onChange }: { values: SourceValues; onChange: (values: SourceValues) => void }) {
  const t = useTranslations('import.source')
  const set = (patch: Partial<SourceValues>) => onChange({ ...values, ...patch })
  const remote = values.dialect !== 'sqlite'
  return (
    <div className="flex flex-col gap-8">
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-4 font-pixel text-pixel-1 text-text-muted">{t('database')}</legend>
        <Field label={t('dialect')} nativeLabel={false} description={t('dialectHint')}>
          <SegmentedControl
            options={[
              { value: 'mysql', label: t('dialects.mysql') },
              { value: 'postgres', label: t('dialects.postgres') },
              { value: 'sqlite', label: t('dialects.sqlite') },
            ]}
            value={values.dialect}
            onValueChange={(dialect) =>
              set({
                dialect,
                // 端口还是另一种数据库的默认值时，跟着换
                port: values.port === defaultPorts[values.dialect] ? defaultPorts[dialect] : values.port,
              })
            }
          />
        </Field>
        {remote ? (
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-4">
              <Field label={t('host')} name="host">
                <Input value={values.host} onValueChange={(host) => set({ host })} required autoComplete="off" />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label={t('port')} name="port">
                <Input
                  value={values.port}
                  onValueChange={(port) => set({ port })}
                  required
                  inputMode="numeric"
                  pattern="[0-9]{1,5}"
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label={t('databaseName')} name="database">
                <Input value={values.database} onValueChange={(database) => set({ database })} required />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label={t('username')} name="username">
                <Input value={values.username} onValueChange={(username) => set({ username })} autoComplete="off" />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label={t('password')} name="password">
                <Input
                  type="password"
                  value={values.password}
                  onValueChange={(password) => set({ password })}
                  autoComplete="new-password"
                />
              </Field>
            </div>
          </div>
        ) : (
          <Field label={t('file')} name="connection" description={t('fileHint')}>
            <Input
              value={values.file}
              onValueChange={(file) => set({ file })}
              required
              placeholder="/srv/blessing-skin/database/database.sqlite"
            />
          </Field>
        )}
        <div className="sm:max-w-xs">
          <Field label={t('prefix')} name="prefix" description={t('prefixHint')}>
            <Input
              value={values.prefix}
              onValueChange={(prefix) => set({ prefix })}
              pattern="[A-Za-z0-9_]*"
              maxLength={64}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-4 font-pixel text-pixel-1 text-text-muted">{t('site')}</legend>
        <Field label={t('textures')} name="texturesDirectory" description={t('texturesHint')}>
          <Input
            value={values.texturesDirectory}
            onValueChange={(texturesDirectory) => set({ texturesDirectory })}
            required
            placeholder="/srv/blessing-skin/storage/textures"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('timeZone')} name="timeZone" description={t('timeZoneHint')}>
            <Input value={values.timeZone} onValueChange={(timeZone) => set({ timeZone })} required maxLength={64} />
          </Field>
          <Field
            label={t('passwordMethod')}
            name="passwordMethod"
            nativeLabel={false}
            description={t('passwordMethodHint')}
          >
            <Select
              options={[
                { value: '', label: t('passwordMethodUnknown') },
                ...passwordMethods.map((method) => ({ value: method, label: method })),
              ]}
              value={values.passwordMethod}
              onValueChange={(passwordMethod) => set({ passwordMethod })}
            />
          </Field>
        </div>
        <div className="sm:max-w-md">
          <Field label={t('salt')} name="salt" description={t('saltHint')}>
            <Input type="password" value={values.salt} onValueChange={(salt) => set({ salt })} autoComplete="off" />
          </Field>
        </div>
      </fieldset>
    </div>
  )
}

/** “检查”的结果：认出了什么、材质目录能不能读。不阻止下一步以外的任何操作 */
export function CheckResult({ result }: { result: ImportCheckResult }) {
  const t = useTranslations('import.check')
  const format = useFormatter()
  const { database, textures } = result
  return (
    <div className="flex flex-col gap-3">
      {database.status === 'ok' ? (
        <Alert tone="success" title={t('databaseOk', { version: database.bsVersion ?? t('unknownVersion') })}>
          <ul className="flex flex-col gap-1">
            <li>
              {t('counts', {
                users: format.number(database.counts.users),
                players: format.number(database.counts.players),
                textures: format.number(database.counts.textures),
              })}
            </li>
            <li>{database.uuidTable ? t('uuidTable', { plugin: database.uuidTable }) : t('noUuidTable')}</li>
            {database.descriptions && <li>{t('descriptions')}</li>}
            {database.unknownTables.length > 0 && (
              <li>
                {t('unknownTables', {
                  count: database.unknownTables.length,
                  names: database.unknownTables.map((table) => table.name).join(', '),
                })}
              </li>
            )}
          </ul>
        </Alert>
      ) : (
        <Alert tone="danger" title={t(`database.${database.status}`)}>
          {database.status === 'not_blessing_skin' && database.detail
            ? t('missing', { name: database.detail })
            : t(`databaseHints.${database.status}`)}
        </Alert>
      )}
      {!textures.readable ? (
        <Alert tone="danger" title={t('texturesUnreadable')}>
          {t('texturesUnreadableHint')}
        </Alert>
      ) : textures.missing > 0 ? (
        <Alert tone="warning" title={t('texturesMissing', { missing: textures.missing, sampled: textures.sampled })}>
          {t('texturesMissingHint')}
        </Alert>
      ) : (
        <Alert tone="success" title={t('texturesOk')}>
          {textures.sampled > 0 ? t('texturesSampled', { count: textures.sampled }) : t('texturesEmpty')}
        </Alert>
      )}
    </div>
  )
}
