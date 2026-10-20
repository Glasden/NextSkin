// 先检查版本再加载启动器，让旧 Node 也能给出可读的提示（ADR-0039）。
var major = Number(process.versions.node.split('.')[0])
if (major < 24) {
  console.error('[nextskin] 需要 Node 24 或更新版本，推荐 Node 26；当前版本 ' + process.versions.node)
  process.exitCode = 78
} else {
  import('./cli/main.mjs').catch(function (error) {
    console.error('[nextskin] 无法加载启动器，请检查发行目录是否完整：' + (error && error.message))
    process.exitCode = 1
  })
}
