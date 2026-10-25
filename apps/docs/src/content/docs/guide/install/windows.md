---
title: Windows
description: 在 Windows 上运行 NextSkin：在控制台里启动，或者用 NSSM 做成服务。
---

## 在控制台里运行

1. 装 Node 26（官方安装包）。
2. 解压 `nextskin-<版本>.zip`，用资源管理器解压也行（包里没有符号链接，路径也不长）。
3. 在 `nextskin` 目录里打开 PowerShell：

   ```powershell
   node nextskin.mjs start
   ```

   第一次启动生成 `.env`，**备份它**。安装码在 `data\setup-code`，打开 `http://localhost:3000/setup` [建站](/guide/install/#建站)。
4. 停止：按 Ctrl+C，核心先收尾，最多 30 秒，到时强制结束；再按一次 Ctrl+C 立即强制结束。强制结束时日志里记一条“强制结束”。不要直接关窗口：Windows 大约 5 秒后就强制结束进程，核心来不及收尾（进程不会残留）。

前面有同机的反向代理（IIS、nginx、Caddy）时，在 `.env` 里加一行 `NEXTSKIN_HOST=127.0.0.1`，Windows 防火墙也不用放行 3000。反向代理要带的请求头见[反向代理与 HTTPS](/guide/install/reverse-proxy/)。

## 做成服务：NSSM

服务停止时必须发 Ctrl+C 并等够 40 秒，直接结束进程会让核心来不及收尾。[NSSM](https://nssm.cc/) 能做到：

```powershell
nssm install NextSkin "C:\Program Files\nodejs\node.exe" "C:\nextskin\nextskin.mjs start"
nssm set NextSkin AppDirectory C:\nextskin
nssm set NextSkin AppStopMethodSkip 6          # 先发 Ctrl+C，跳过 WM_CLOSE 和 WM_QUIT
nssm set NextSkin AppStopMethodConsole 40000   # Ctrl+C 之后等 40 秒，默认 1.5 秒
nssm set NextSkin AppExit 78 Exit              # 配置错误不重启
nssm start NextSkin
```

- 服务账户（默认 LocalSystem）要能写 `C:\nextskin`：第一次启动要在这里生成 `.env`、在 `data` 下建库。换成专用账户时给它这两处的写权限。
- 直接建在 C 盘根下的目录默认继承“Authenticated Users：修改”：本机的任何账户都能改程序、读 `.env`，而服务以 LocalSystem 运行。装服务之前在管理员 PowerShell 里收紧权限，只留 SYSTEM 和管理员（换成专用账户时再加上 `/grant 账户:(OI)(CI)M`）：

  ```powershell
  icacls C:\nextskin /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
  ```

- 命令行在**以管理员身份打开**的 PowerShell 里运行：控制通道的命名管道只让 SYSTEM、管理员和运行服务的账户连接，普通的 PowerShell 会报“没有权限连接管理进程”。换成专用账户时用那个账户运行；用别的账户时，`data` 里新建的文件服务可能读写不了。
- 日志在 `C:\nextskin\data\logs\nextskin.log`，按后台“设置 → 高级”里的上限轮换，不用设 NSSM 的 `AppStdout`、`AppStderr`。服务起不来、以 78 退出（配置错误）时，原因只写终端、NSSM 不记：在管理员 PowerShell 里运行 `node nextskin.mjs doctor` 看哪一项失败。
- 核对：`nssm stop NextSkin` 之后日志里应该有启动器按顺序停止核心的记录（“正在停止核心”）。几秒内就被结束、没有这些记录，说明 Ctrl+C 没送到。事件日志里 NSSM 每次停服务都会记“Killing process …”，正常收尾时也一样，以 `nextskin.log` 为准。
- 核心收尾超过 3 秒时，`nssm stop` 会先返回并报 `Unexpected status SERVICE_STOP_PENDING in response to STOP control.`，服务其实还在停。要动文件（比如手动升级）之前，等 `sc.exe query NextSkin` 显示 `STOPPED`。

:::note
在 Windows 11 上用控制台和 NSSM 2.24 各实测过一遍：Ctrl+C、关窗口和 `nssm stop` 的停止顺序，核心卡住时 30 秒强制结束；0.7.x 之间的一键升级、回滚和手动升级，卡巴斯基占着刚解压的文件、`current.json` 被占着时的恢复；没提升的命令行连 LocalSystem 的服务。
:::

## 升级

- 后台“更新”页能一键升级，见[升级与回退](/guide/upgrade/)。运行服务的账户要能写 `releases\`。
- 控制通道是命名管道：能连上的只有运行服务的账户、SYSTEM 和以管理员身份运行的进程，请求还要带上 `releases\manager.token` 里的令牌。
- 杀毒软件会扫刚解压的发行包，扫完之前目录改不了名：准备时最多等一分钟左右（实测卡巴斯基要几秒）。
- 替换 `releases\current.json` 时文件被占着会重试几秒。切换时还写不进去就照旧运行原来的版本；指针写不回去时结果里会写明，重启服务之前把 `current.json` 改成指向哪个版本。删不掉的旧版本目录留到下次启动再删，不影响站点。
- 手动升级：停服务（等到 `STOPPED`）→ 备份 `data` 和 `.env` → 用资源管理器或 `Expand-Archive -Force` 把新的 ZIP 覆盖解压到原目录 → 启动。
