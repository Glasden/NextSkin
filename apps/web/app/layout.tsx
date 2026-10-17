import { NextIntlClientProvider } from 'next-intl'
import { getLocale } from 'next-intl/server'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata = { title: 'NextSkin' }

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang={await getLocale()}>
      <body className="min-h-dvh bg-bg font-sans text-text">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  )
}
