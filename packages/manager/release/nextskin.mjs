// 入口保留旧 Node 能解析的语法：版本检查通过后才加载管理进程。
// 一键升级只解压 releases/<版本>/ 和 manager/，不更新本文件；装好以后它可能一直是第一次解压时的那份。
// 后来的管理进程都要能被最早的入口加载：只靠 manager/main.mjs、manager/VERSION、manager.next/VERSION、NEXTSKIN_MANAGER 这几处约定，改动要向前兼容（ADR-0061）。
export function checkNode(version) {
  return Number(version.split('.')[0]) >= 24
}

export function compareVersions(a, b) {
  function parse(value) {
    var match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
        value,
      )
    if (!match) throw new Error('版本号不符合 semver')
    var pre = match[4] && match[4].split('.')
    if (
      pre &&
      pre.some(function (part) {
        return /^0\d+$/.test(part)
      })
    )
      throw new Error('预发布版本数字不能有前导零')
    return { core: match.slice(1, 4), pre: pre }
  }
  function part(left, right) {
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
      if (left.length !== right.length) return left.length < right.length ? -1 : 1
    }
    return left < right ? -1 : left > right ? 1 : 0
  }
  var left = parse(a)
  var right = parse(b)
  for (var i = 0; i < 3; i++) {
    var order = part(left.core[i], right.core[i])
    if (order) return order
  }
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0
  for (var j = 0; j < Math.max(left.pre.length, right.pre.length); j++) {
    var l = left.pre[j]
    var r = right.pre[j]
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1
    if (l === r) continue
    var ln = /^\d+$/.test(l)
    var rn = /^\d+$/.test(r)
    return ln !== rn ? (ln ? -1 : 1) : part(l, r)
  }
  return 0
}

export async function promoteManager(home, options) {
  options = options || {}
  var fs = options.fs || (await import('node:fs/promises'))
  var path = await import('node:path')
  var log = options.log || console.error
  var current = path.join(home, 'manager')
  var next = path.join(home, 'manager.next')
  var old = path.join(home, 'manager.old')
  var recovery = path.join(home, 'manager.recovery')
  var preserved = false
  var movedOld = false
  var movedNext = false
  try {
    var nextVersion
    try {
      nextVersion = (await fs.readFile(path.join(next, 'VERSION'), 'utf8')).trim()
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
    var currentVersion = (await fs.readFile(path.join(current, 'VERSION'), 'utf8')).trim()
    if (compareVersions(nextVersion, currentVersion) <= 0) return false
    await fs.rename(current, old)
    movedOld = true
    await fs.rename(next, current)
    movedNext = true
    // 递归删除可能只删掉一部分才失败；保留副本，保证这一步失败仍能恢复完整旧版。
    var copy = fs.cp || (await import('node:fs/promises')).cp
    await copy(old, recovery, { recursive: true, errorOnExist: true, force: false })
    preserved = true
    await fs.rm(old, { recursive: true })
    // 换代已经提交；清理冗余副本失败不影响两份可用代码。
    await fs.rm(recovery, { recursive: true, force: true }).catch(function () {
      log('[nextskin] 新管理进程已换上，manager.recovery 暂时无法删除，请稍后清理')
    })
    return true
  } catch (error) {
    // 两次改名中任一步失败，都尽量把两个目录放回原位；不用拷贝覆盖正在用的代码。
    try {
      if (movedNext) await fs.rename(current, next)
      if (movedOld) await fs.rename(preserved ? recovery : old, current)
      if (preserved) await fs.rm(old, { recursive: true, force: true }).catch(function () {})
      else await fs.rm(recovery, { recursive: true, force: true }).catch(function () {})
    } catch (restoreError) {
      log('[nextskin] 恢复旧管理进程失败：' + restoreError.code + '；请恢复 manager.old 为 manager')
    }
    log('[nextskin] 没有换上新管理进程，继续使用旧版：' + (error.code || error.message))
    return false
  }
}

export async function boot() {
  if (!checkNode(process.versions.node)) {
    console.error('[nextskin] 需要 Node 24 或更新版本，推荐 Node 26；当前版本 ' + process.versions.node)
    process.exitCode = 78
    return
  }
  var path = await import('node:path')
  var url = await import('node:url')
  var home = path.dirname(url.fileURLToPath(import.meta.url))
  if (process.env.NEXTSKIN_MANAGER !== 'off') await promoteManager(home)
  try {
    await import('./manager/main.mjs')
  } catch {
    console.error('[nextskin] 发行目录不完整，无法加载管理进程，请重新解压完整发行包')
    process.exitCode = 1
  }
}

// 测试可以导入检查函数，不执行发行入口。
if (!checkNode(process.versions.node)) {
  console.error('[nextskin] 需要 Node 24 或更新版本，推荐 Node 26；当前版本 ' + process.versions.node)
  process.exitCode = 78
} else
  import('node:url')
    .then(async function (url) {
      if (!process.argv[1]) return
      var direct
      try {
        var fs = await import('node:fs')
        direct = fs.realpathSync(process.argv[1]) === url.fileURLToPath(import.meta.url)
      } catch {
        direct = true
      }
      if (direct) return boot()
    })
    .catch(function () {
      process.exitCode = 1
    })
