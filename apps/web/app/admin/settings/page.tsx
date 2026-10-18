import { redirect } from 'next/navigation'
import { requireAdmin } from '../../../lib/session'
import { settingsHref } from './setting-text'

/** 设置页按分区分成几页，进来先到第一个分区（ADR-0028） */
export default async function SettingsIndexPage() {
  await requireAdmin('/admin/settings', 'settings.manage')
  return redirect(settingsHref('site'))
}
