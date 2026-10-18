'use client'

import { Button, Menu, MenuItem, MenuLinkItem, MenuSeparator, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { Logout } from 'pixelarticons/react/Logout.js'
import { Tools } from 'pixelarticons/react/Tools.js'
import { useState } from 'react'
import { postJson } from '../../lib/api-client'
import { userNavItems } from './user-nav'

function useSignOut() {
  const t = useTranslations('user.menu')
  const router = useRouter()
  const toast = useToast()
  return async () => {
    const { status } = await postJson('/api/auth/sign-out', {})
    if (status !== 200) {
      toast.show({ tone: 'danger', title: t('signOutFailed') })
      return
    }
    router.replace('/sign-in')
    router.refresh()
  }
}

/** 页头右上角的用户菜单：用户中心的各个分区、管理后台（有后台权限时）和退出登录 */
export function UserMenu({ nickname, admin }: { nickname: string; admin: boolean }) {
  const t = useTranslations('user')
  const signOut = useSignOut()
  return (
    <Menu label={nickname} align="end">
      {userNavItems.map(({ href, icon: Icon, label }) => (
        <MenuLinkItem key={href} render={<NextLink href={href} />} icon={<Icon />}>
          {t(`nav.${label}`)}
        </MenuLinkItem>
      ))}
      {admin && (
        <>
          <MenuSeparator />
          <MenuLinkItem render={<NextLink href="/admin" />} icon={<Tools />}>
            {t('menu.admin')}
          </MenuLinkItem>
        </>
      )}
      <MenuSeparator />
      <MenuItem icon={<Logout />} onClick={() => void signOut()}>
        {t('menu.signOut')}
      </MenuItem>
    </Menu>
  )
}

/** 封禁页上的退出登录 */
export function SignOutButton() {
  const t = useTranslations('user.banned')
  const signOut = useSignOut()
  const [pending, setPending] = useState(false)
  return (
    <Button
      loading={pending}
      onClick={() => {
        setPending(true)
        void signOut().finally(() => setPending(false))
      }}
    >
      {t('signOut')}
    </Button>
  )
}
