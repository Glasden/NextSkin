import { coreSettingsRegistry, settingSections, type SettingSection } from '@nextskin/domain'
import type { Metadata } from 'next'
import { getMessages, getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getServer } from '../../../../lib/server'
import { requireAdmin } from '../../../../lib/session'
import { settingText, type SettingItem } from '../setting-text'
import { SettingsForm } from '../settings-form'
import { SettingsTabs } from '../settings-tabs'
import { TestCaptcha } from '../test-captcha'
import { TestMail } from '../test-mail'

function isSection(value: string): value is SettingSection {
  return (settingSections as readonly string[]).includes(value)
}

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }): Promise<Metadata> {
  const [{ section }, t] = await Promise.all([params, getTranslations('admin.settings')])
  return { title: isSection(section) ? `${t(`sections.${section}`)} · ${t('title')}` : t('title') }
}

/**
 * 站点设置的一个分区（ADR-0028）。表单由设置注册表生成：控件来自每一项的 JSON Schema，文案按键名取；
 * 机密项的值不会到浏览器，只知道设没设过。只有超级管理员（settings.manage）能进来
 */
export default async function SettingsPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params
  const user = await requireAdmin(`/admin/settings/${section}`, 'settings.manage')
  if (!isSection(section)) notFound()
  const { core } = await getServer()
  const [views, t, messages, captcha] = await Promise.all([
    core.admin.settingsSection(section),
    getTranslations('admin.settings'),
    getMessages(),
    // 测试验证码用已经保存的设置（ADR-0038"后台"）
    section === 'captcha' ? core.captcha.publicConfig() : null,
  ])
  const fields = messages.admin.settings.fields
  const items: SettingItem[] = views.map((view) => ({
    ...view,
    text: settingText(fields, view.key),
    defaultValue: coreSettingsRegistry[view.key].default,
  }))

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>
      <SettingsTabs
        section={section}
        label={t('tabsLabel')}
        items={settingSections.map((value) => ({ value, label: t(`sections.${value}`) }))}
      >
        <div className="flex max-w-3xl flex-col gap-6">
          <SettingsForm items={items} label={t(`sections.${section}`)} />
          {section === 'mail' && <TestMail email={user.email} />}
          {section === 'captcha' && <TestCaptcha config={captcha} />}
        </div>
      </SettingsTabs>
    </div>
  )
}
