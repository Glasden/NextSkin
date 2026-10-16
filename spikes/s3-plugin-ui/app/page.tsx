import { Card } from '@nextskin/ui'
import { PluginSlot } from '@/src/host/plugin-slot'
import { slotEntries, sriMode } from '@/src/host/registry'
import { SsrPreload } from '@/src/host/ssr-preload'

export default async function Home() {
  const sri = await sriMode()
  const [dashboard, footer] = await Promise.all([
    slotEntries('user.dashboard', sri),
    slotEntries('player.card.footer', sri, { player: 'Steve' }),
  ])
  return (
    <>
      <SsrPreload entries={[...dashboard, ...footer]} />
      <Card title="宿主内容">
        <p data-testid="host-content">这一块由宿主渲染。</p>
      </Card>
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">user.dashboard</h2>
        <PluginSlot name="user.dashboard" entries={dashboard} />
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">player.card.footer</h2>
        <PluginSlot name="player.card.footer" entries={footer} />
      </section>
    </>
  )
}
