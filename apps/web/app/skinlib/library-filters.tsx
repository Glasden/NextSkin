'use client'

import { SegmentedControl } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { libraryHref, LIBRARY_SORTS, LIBRARY_TYPES, type LibraryParams } from './params'

/** 类型和排序：即时切换，改的是地址 */
export function LibraryFilters({ params }: { params: LibraryParams }) {
  const t = useTranslations('skinlib.list')
  const router = useRouter()
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SegmentedControl
        aria-label={t('typeLabel')}
        value={params.type}
        onValueChange={(type) => router.push(libraryHref(params, { type }))}
        options={LIBRARY_TYPES.map((value) => ({ value, label: t(`types.${value}`) }))}
      />
      <SegmentedControl
        aria-label={t('sortLabel')}
        value={params.sort}
        onValueChange={(sort) => router.push(libraryHref(params, { sort }))}
        options={LIBRARY_SORTS.map((value) => ({ value, label: t(`sorts.${value}`) }))}
      />
    </div>
  )
}
