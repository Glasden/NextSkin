import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale } from 'next-intl/server'
import type { ReactNode } from 'react'
import { getServer } from '../lib/server'
import './globals.css'

export async function generateMetadata(): Promise<Metadata> {
  const { core } = await getServer()
  const { 'site.name': name } = await core.settings.read(['site.name'])
  return { title: { default: name, template: `%s · ${name}` } }
}

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang={await getLocale()}>
      <body className="min-h-dvh bg-bg font-sans text-text">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  )
}
