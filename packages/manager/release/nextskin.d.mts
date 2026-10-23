import type { readFile, rename, rm } from 'node:fs/promises'
export function checkNode(version: string): boolean
export function compareVersions(a: string, b: string): number
export function promoteManager(
  home: string,
  options?: {
    fs?: { readFile: typeof readFile; rename: typeof rename; rm: typeof rm }
    log?: (line: string) => void
  },
): Promise<boolean>
export function boot(): Promise<void>
