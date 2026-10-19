export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
  readonly build: readonly string[]
}

const NUMBER = '(0|[1-9][0-9]*)'
const VERSION = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
)

export function parseVersion(value: string): Version | null {
  const match = VERSION.exec(value)
  if (!match || match[0] !== value) return null
  const [major, minor, patch] = match.slice(1, 4).map(Number)
  const prerelease = match[4]?.split('.') ?? []
  if (![major, minor, patch].every(Number.isSafeInteger) || prerelease.some((p) => /^0[0-9]+$/.test(p))) return null
  return { major: major!, minor: minor!, patch: patch!, prerelease, build: match[5]?.split('.') ?? [] }
}

export function isValidVersion(value: string): boolean {
  return parseVersion(value) !== null
}

export function compareVersions(a: string | Version, b: string | Version): number {
  const left = typeof a === 'string' ? parseVersion(a) : a
  const right = typeof b === 'string' ? parseVersion(b) : b
  if (!left || !right) throw new Error('版本必须是合法的 semver')
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (!left.prerelease.length || !right.prerelease.length)
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i]
    const y = right.prerelease[i]
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1
    if (x === y) continue
    const xn = /^[0-9]+$/.test(x)
    const yn = /^[0-9]+$/.test(y)
    if (xn && yn) return x.length !== y.length ? (x.length < y.length ? -1 : 1) : x < y ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

type Operator = '=' | '>' | '>=' | '<' | '<='
interface Comparator {
  op: Operator
  version: Version
}

function comparator(op: Operator, value: string): Comparator {
  const version = parseVersion(value)
  if (!version) throw new Error('版本范围不合法')
  return { op, version }
}

/** 将简写展开为比较符；不实现 npm 的连字符范围、标签等额外语法。 */
function expand(token: string): Comparator[] {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)
  if (!match) throw new Error('版本范围不合法')
  const op = match[1] ?? '='
  const raw = match[2]!
  const full = parseVersion(raw)
  if (full && op !== '^' && op !== '~') return [comparator(op as Operator, raw)]
  const parts = /^(0|[1-9][0-9]*|[xX*])(?:\.(0|[1-9][0-9]*|[xX*]))?(?:\.(0|[1-9][0-9]*|[xX*]))?$/.exec(raw)
  if (!full && !parts) throw new Error('版本范围不合法')
  const nums = full
    ? [full.major, full.minor, full.patch]
    : parts!.slice(1, 4).map((p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p)))
  const firstMissing = nums.findIndex((p) => p === null)
  const count = firstMissing < 0 ? 3 : firstMissing
  if (nums.slice(count).some((p) => p !== null) || nums.some((p) => p !== null && !Number.isSafeInteger(p)))
    throw new Error('版本范围不合法')
  if (!count) return op === '>' || op === '<' ? [comparator('<', '0.0.0-0')] : []
  const [major, minor, patch] = nums.map((p) => p ?? 0) as [number, number, number]
  const lower = full ? raw : `${major}.${minor}.${patch}`
  const next = count === 1 ? `${major + 1}.0.0-0` : `${major}.${minor + 1}.0-0`
  if (op === '^' || op === '~') {
    const upper =
      op === '~'
        ? next
        : major > 0 || count === 1
          ? `${major + 1}.0.0-0`
          : minor > 0 || count === 2
            ? `0.${minor + 1}.0-0`
            : `0.0.${patch + 1}-0`
    return [comparator('>=', lower), comparator('<', upper)]
  }
  if (count === 3) return [comparator(op as Operator, lower)]
  if (op === '=') return [comparator('>=', lower), comparator('<', next)]
  if (op === '>') return [comparator('>=', next.replace(/-0$/, ''))]
  if (op === '<=') return [comparator('<', next)]
  if (op === '<') return [comparator('<', `${lower}-0`)]
  return [comparator('>=', lower)]
}

function parseRange(range: string): Comparator[][] {
  if (!range.trim()) throw new Error('版本范围不能为空')
  return range.split('||').map((part) => {
    const normalized = part.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    if (!normalized) throw new Error('版本范围不合法')
    return normalized.split(/\s+/).flatMap(expand)
  })
}

export function isValidRange(range: string): boolean {
  try {
    parseRange(range)
    return true
  } catch {
    return false
  }
}

export function satisfies(version: string, range: string): boolean {
  const value = parseVersion(version)
  if (!value) return false
  try {
    return parseRange(range).some((comparators) => {
      if (
        value.prerelease.length &&
        !comparators.some(
          ({ version: v }) =>
            v.prerelease.length && v.major === value.major && v.minor === value.minor && v.patch === value.patch,
        )
      )
        return false
      return comparators.every(({ op, version: v }) => {
        const c = compareVersions(value, v)
        return op === '=' ? c === 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '<' ? c < 0 : c <= 0
      })
    })
  } catch {
    return false
  }
}
