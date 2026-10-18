'use client'

import { SegmentedControl } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { USER_ROLE_FILTERS, usersHref, type UserParams } from '../params'

/** 按角色筛选：即时切换，改的是地址；搜索词留着 */
export function RoleFilter({ params }: { params: UserParams }) {
  const t = useTranslations('admin')
  const router = useRouter()
  return (
    <SegmentedControl
      size="sm"
      aria-label={t('users.roleLabel')}
      value={params.role}
      onValueChange={(role) => router.push(usersHref(params, { role }))}
      options={USER_ROLE_FILTERS.map((value) => ({
        value,
        label: value === 'all' ? t('users.roleAll') : t(`roles.${value}`),
      }))}
    />
  )
}
