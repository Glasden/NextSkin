/**
 * 正常插件：hooks、Suspense + use()、transition、context（usePlugin）、portal、宿主组件（含 Base UI 对话框）、软导航。
 */
import * as React from 'react'
import { Suspense, use, useEffect, useId, useState, useTransition } from 'react'
import * as ReactDOM from 'react-dom'
import { createPortal } from 'react-dom'
import { jsx } from 'react/jsx-runtime'
import * as Client from '@nextskin/plugin-client'
import { usePlugin } from '@nextskin/plugin-client'
import * as Ui from '@nextskin/ui'
import { Button, Card, Dialog } from '@nextskin/ui'

/** 测试用：比较插件拿到的模块对象和宿主登记的是不是同一份 */
export const probe = { React, ReactDOM, jsx, Ui, Client }

const greetings = new Map<string, Promise<string>>()

function Greeting() {
  const plugin = usePlugin()
  let pending = greetings.get(plugin.id)
  if (pending === undefined) {
    pending = plugin
      .fetch('/greeting')
      .then((r) => r.json() as Promise<{ greeting: string }>)
      .then((j) => j.greeting)
    greetings.set(plugin.id, pending)
  }
  return <span data-testid="hello-greeting">{use(pending)}</span>
}

export default function Hello() {
  const plugin = usePlugin()
  const inputId = useId()
  const [count, setCount] = useState(0)
  const [text, setText] = useState('')
  const [effectRan, setEffectRan] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)

  useEffect(() => setEffectRan(true), [])

  return (
    <Card title={`hello ${__VERSION__}`}>
      <div className="grid gap-3">
        <p data-testid="hello-meta" data-plugin-id={plugin.id} data-slot={plugin.slot} data-version={__VERSION__} data-effect={String(effectRan)}>
          插件 {plugin.id}@{plugin.version}，插槽 {plugin.slot}
        </p>
        <label htmlFor={inputId} className="text-sm">
          输入
          <input id={inputId} data-testid="hello-input" className="ml-2 border-2 border-border bg-surface-sunken px-1" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <span data-testid="hello-echo">{text}</span>
        <div className="flex flex-wrap gap-2">
          <Button tone="accent" data-testid="hello-count" onClick={() => setCount((c) => c + 1)}>
            点了 {count} 次
          </Button>
          <Button data-testid="hello-transition" data-pending={String(isPending)} onClick={() => startTransition(() => setCount((c) => c + 10))}>
            transition +10
          </Button>
          <Button data-testid="hello-navigate" onClick={() => plugin.navigate('/other')}>
            去另一页
          </Button>
          <Dialog trigger="打开对话框" title="插件对话框">
            <p data-testid="hello-dialog-body">这段内容由插件提供，对话框由宿主的组件库渲染。</p>
          </Dialog>
        </div>
        <Suspense fallback={<span data-testid="hello-greeting-loading">加载问候…</span>}>
          <Greeting />
        </Suspense>
        <div ref={setPortalHost} data-testid="hello-portal-host" />
        {portalHost !== null ? createPortal(<span data-testid="hello-portal">portal 内容</span>, portalHost) : null}
      </div>
    </Card>
  )
}

export function PlayerFooter({ player }: { readonly player: string }) {
  const plugin = usePlugin()
  return (
    <p data-testid="hello-player" data-slot={plugin.slot} className="text-sm">
      {player} · hello {__VERSION__}
    </p>
  )
}
