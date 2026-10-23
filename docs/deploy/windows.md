# Windows

实测：在 Windows 上从发行目录启动（e2e 在 Windows 上从发行目录跑过）。Ctrl+C 的停止顺序和做成服务（NSSM）未实测。公共部分见 [README.md](README.md)。

## 在控制台里运行

1. 装 Node 26（官方安装包）。
2. 解压 `nextskin-<版本>.zip`，资源管理器解压也行（包里没有符号链接，路径不长）。
3. 在 `nextskin` 目录里打开 PowerShell：

   ```powershell
   node nextskin.mjs start
   ```

   第一次启动生成 `.env`，备份它。安装码在 `data\setup-code`。
4. Ctrl+C 停止：核心先收尾，最多 30 秒；再按一次 Ctrl+C，启动器立即强杀核心。不要直接关窗口：Windows 几秒后就强制结束进程，来不及收尾。

前面有同机的反向代理（IIS、nginx、Caddy）时，在 `.env` 里加 `NEXTSKIN_HOST=127.0.0.1`，Windows 防火墙也不用放行 3000。

## 升级（一键升级未实测）

- 后台"更新"页能一键升级，运行服务的账户要能写 `releases\`。控制通道是命名管道 `\\.\pipe\nextskin-<实例目录的 hash>`，访问控制只靠 `releases\manager.token` 里的令牌：同一台机器上能读这个文件的账户都能发升级请求。
- 删旧版本目录、替换 `releases\current.json` 时被杀毒软件或资源管理器占着：重试几次；删不掉的旧版本留到下次启动再删，不影响站点。
- 手动升级：停服务 → 备份 → 用资源管理器或 `Expand-Archive -Force` 把新的 ZIP 覆盖解压到原目录 → 启动。
- Ctrl+C 同一个控制台里的三层进程（管理进程、启动器、核心）都会收到，各自按顺序停下，停止的顺序未实测。

## 做成服务：NSSM（未实测）

服务停止时必须发 Ctrl+C 并等够 40 秒：直接结束进程，核心来不及收尾。NSSM 能做到：

```powershell
nssm install NextSkin "C:\Program Files\nodejs\node.exe" "C:\nextskin\nextskin.mjs start"
nssm set NextSkin AppDirectory C:\nextskin
nssm set NextSkin AppStopMethodSkip 6          # 先发 Ctrl+C，跳过 WM_CLOSE 和 WM_QUIT
nssm set NextSkin AppStopMethodConsole 40000   # Ctrl+C 之后等 40 秒，默认 1.5 秒
nssm set NextSkin AppExit 78 Exit              # 配置错误不重启
nssm set NextSkin AppStdout C:\nextskin\data\nextskin.log
nssm set NextSkin AppStderr C:\nextskin\data\nextskin.log
nssm start NextSkin
```

- 服务账户（默认 LocalSystem）要能写 `C:\nextskin`：第一次启动要在这里生成 `.env`、在 `data` 下建库。换成专用账户时给它这两处的写权限。
- 命令行用同一个账户运行；用别的账户时，`data` 里新建的文件服务可能读写不了。
- 核对：`nssm stop NextSkin` 之后日志里应有启动器按顺序停止核心的记录；如果几秒内就被结束、没有这些记录，说明 Ctrl+C 没送到。
