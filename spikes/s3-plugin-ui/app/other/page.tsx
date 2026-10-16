import { PluginSlot } from '@/src/host/plugin-slot'
import { slotEntries, sriMode } from '@/src/host/registry'

export default async function Other() {
  const entries = await slotEntries('user.profile.sections', await sriMode())
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-semibold" data-testid="other-page">user.profile.sections</h2>
      <PluginSlot name="user.profile.sections" entries={entries} />
    </section>
  )
}
