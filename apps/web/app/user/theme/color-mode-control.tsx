'use client'

import { SegmentedControl } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { colorModes } from '../../../lib/color-mode'
import { useColorMode } from '../../color-mode-menu'

/** 主题页上方的亮暗模式：和页头右上角的菜单是同一个 Cookie，改了一处另一处跟着变 */
export function ColorModeControl() {
  const t = useTranslations('site.colorMode')
  const [mode, setMode] = useColorMode()
  return (
    <SegmentedControl
      aria-label={t('label')}
      value={mode}
      onValueChange={setMode}
      options={colorModes.map((value) => ({ value, label: t(value) }))}
    />
  )
}
