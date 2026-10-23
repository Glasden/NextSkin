/** 正式版的版本号：进清单的只有正式版 */
export const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** 发布公钥的 key id */
export const keyIdPattern = /^[a-z0-9-]{1,32}$/

function parseVersion(version: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    )
  if (!match) throw new Error('版本号必须符合 semver')
  const prerelease = match[4]?.split('.')
  if (prerelease?.some((part) => /^0\d+$/.test(part))) throw new Error('预发布版本的数字标识不能有前导零')
  return { core: match.slice(1, 4), prerelease }
}

function comparePart(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
  return a < b ? -1 : a > b ? 1 : 0
}

/** 遵循 semver 的优先级；构建元数据不影响排序。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const order = comparePart(left.core[i]!, right.core[i]!)
    if (order) return order
  }
  if (!left.prerelease || !right.prerelease) return left.prerelease ? -1 : right.prerelease ? 1 : 0
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const l = left.prerelease[i]
    const r = right.prerelease[i]
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1
    if (l === r) continue
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    return ln !== rn ? (ln ? -1 : 1) : comparePart(l, r)
  }
  return 0
}
