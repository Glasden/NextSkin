import { Alert, Markdown, Panel } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { getServer } from '../../../lib/server'
import { requireUser } from '../../../lib/session'
import { UploadForm } from './upload-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('skinlib.upload')
  return { title: t('title') }
}

/** 上传材质：浏览器先解码出预览、推断模型，服务端再按 ADR-0008 重新把关（ADR-0025） */
export default async function UploadPage() {
  const user = await requireUser('/skinlib/upload')
  const { core } = await getServer()
  const [overview, settings, t] = await Promise.all([
    core.users.overview(user.uid),
    core.settings.read([
      'texture.maxFileSizeKb',
      'texture.nameRegex',
      'score.perKbPublic',
      'score.perKbPrivate',
      'score.perClosetItem',
      'auth.requireEmailVerification',
      'texture.contentPolicy',
    ]),
    getTranslations('skinlib.upload'),
  ])
  if (!overview) redirect('/sign-in')
  // 写操作由用例检查（ADR-0018、ADR-0022）；这里只是不让用户填完才知道不行
  const blocked =
    user.role === 'banned'
      ? t('banned')
      : settings['auth.requireEmailVerification'] && !overview.emailVerified
        ? t('verifyFirst')
        : null

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-pretty text-text-muted">{t('intro')}</p>
      </header>
      {blocked && <Alert tone="warning">{blocked}</Alert>}
      {/* 管理员在后台写的内容政策（ADR-0028），空的时候不显示 */}
      {settings['texture.contentPolicy'].trim() && (
        <section aria-labelledby="content-policy-heading" className="flex flex-col gap-3">
          <h2 id="content-policy-heading" className="font-pixel text-pixel-1 text-text">
            {t('contentPolicy')}
          </h2>
          <Panel padding="responsive">
            <div className="text-sm">
              <Markdown>{settings['texture.contentPolicy']}</Markdown>
            </div>
          </Panel>
        </section>
      )}
      <UploadForm
        disabled={blocked !== null}
        score={overview.score}
        maxFileSizeKb={settings['texture.maxFileSizeKb']}
        nameRegex={settings['texture.nameRegex']}
        prices={{
          public: settings['score.perKbPublic'],
          private: settings['score.perKbPrivate'],
          closetItem: settings['score.perClosetItem'],
        }}
      />
    </div>
  )
}
