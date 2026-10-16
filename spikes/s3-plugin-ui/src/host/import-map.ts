import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { activeModuleIntegrity } from './registry'
import type { SriMode } from './types'

/** scripts/gen-shims.ts 生成 */
interface ShimManifest {
  readonly imports: Readonly<Record<string, string>>
  readonly integrity: Readonly<Record<string, string>>
}

export interface ImportMap {
  readonly imports: Readonly<Record<string, string>>
  readonly integrity?: Readonly<Record<string, string>>
}

export async function importMapFor(sri: SriMode): Promise<ImportMap> {
  const shims = JSON.parse(await readFile(path.join(process.cwd(), 'data/shims/manifest.json'), 'utf8')) as ShimManifest
  if (sri === 'none') return { imports: shims.imports }
  return { imports: shims.imports, integrity: { ...shims.integrity, ...(await activeModuleIntegrity()) } }
}

/** 放进 <script> 的 JSON：转义 <，防止值里出现 </script> */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
