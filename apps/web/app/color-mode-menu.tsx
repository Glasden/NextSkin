'use client'

import { IconButton, Menu, MenuLinkItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { ColorsSwatch } from 'pixelarticons/react/ColorsSwatch.js'
import { Monitor } from 'pixelarticons/react/Monitor.js'
import { Moon } from 'pixelarticons/react/Moon.js'
import { Sun } from 'pixelarticons/react/Sun.js'
import { createContext, use, useSyncExternalStore, type ReactNode } from 'react'
import { COLOR_MODE_CHANGE, COLOR_MODE_COOKIE, colorModes, readColorMode, type ColorMode } from '../lib/color-mode'

const icons = { system: Monitor, light: Sun, dark: Moon } as const satisfies Record<ColorMode, unknown>

const ONE_YEAR = 60 * 60 * 24 * 365

const RequestColorMode = createContext<ColorMode>('system')

/** 根布局按请求带的 Cookie 提供偏好：水合时菜单用它，和服务端渲染的图标一致，不会在水合后跳一下 */
export function ColorModeProvider({ value, children }: { value: ColorMode; children: ReactNode }) {
  return <RequestColorMode value={value}>{children}</RequestColorMode>
}

function subscribe(onChange: () => void) {
  addEventListener(COLOR_MODE_CHANGE, onChange)
  return () => removeEventListener(COLOR_MODE_CHANGE, onChange)
}

function setColorMode(mode: ColorMode) {
  const attributes = `; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
  document.cookie =
    mode === 'system'
      ? `${COLOR_MODE_COOKIE}=; Max-Age=0${attributes}`
      : `${COLOR_MODE_COOKIE}=${mode}; Max-Age=${ONE_YEAR}${attributes}`
  // data-mode 由根布局的内联脚本收到这个事件后重设（lib/color-mode.ts）
  dispatchEvent(new Event(COLOR_MODE_CHANGE))
}

/** 当前的偏好和改它的函数。页头的菜单和用户中心的主题页共用，改了一处另一处跟着变 */
export function useColorMode() {
  const requested = use(RequestColorMode)
  const mode = useSyncExternalStore(
    subscribe,
    () => readColorMode(document.cookie),
    () => requested,
  )
  return [mode, setColorMode] as const
}

/**
 * 页头右上角的亮暗模式菜单：跟随系统、亮色、暗色。按钮的图标是当前的偏好。
 * themeLink：登录用户、启用的主题有两套以上时，下面多一项去用户中心的主题页（ADR-0057）
 */
export function ColorModeMenu({ themeLink = false }: { themeLink?: boolean }) {
  const t = useTranslations('site.colorMode')
  const [mode] = useColorMode()
  const Icon = icons[mode]
  return (
    <Menu
      align="end"
      trigger={
        <IconButton label={t('label')}>
          <Icon />
        </IconButton>
      }
    >
      <MenuRadioGroup label={t('label')} value={mode} onValueChange={setColorMode}>
        {colorModes.map((option) => {
          const OptionIcon = icons[option]
          return (
            <MenuRadioItem key={option} value={option} icon={<OptionIcon aria-hidden />}>
              {t(option)}
            </MenuRadioItem>
          )
        })}
      </MenuRadioGroup>
      {themeLink && (
        <>
          <MenuSeparator />
          <MenuLinkItem render={<NextLink href="/user/theme" />} icon={<ColorsSwatch aria-hidden />}>
            {t('theme')}
          </MenuLinkItem>
        </>
      )}
    </Menu>
  )
}
