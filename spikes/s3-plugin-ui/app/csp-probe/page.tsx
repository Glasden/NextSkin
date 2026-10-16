import { PluginSlot } from '@/src/host/plugin-slot'
import { slotEntries, sriMode } from '@/src/host/registry'

export default async function CspProbe() {
  const entries = await slotEntries('admin.dashboard', await sriMode())
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-semibold">admin.dashboard（CSP 探测）</h2>
      <PluginSlot name="admin.dashboard" entries={entries} />
    </section>
  )
}
