import type { LauncherContext } from '../context.ts'

export function run(_argv: string[], context: LauncherContext): number {
  console.log(context.version)
  return 0
}
