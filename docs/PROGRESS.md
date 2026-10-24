# 进度

只列还没做完的事。判断一个功能有没有：`docs/adr/README.md` 的索引里，已采纳的 ADR 决定要做的都已经落地，除了下面列出的部分；ADR 里写明不做、推迟或另写 ADR 的，不算它的范围。

## 插件

- **插件 SDK 1.0**（ADR-0035）：`1.0.0-rc.7` 推到 main，由 CI 发布（rc.6 没有单独发布）；收集作者意见；退出预发布时去掉 README 和入门里的 `@rc`。
- **插件 API 推迟的部分**：其余写核心数据的能力（ADR-0041 的"以后的写能力"）；其余拦截点、运行时组件、挂在具体对象上的插槽（ADR-0059 只做了两个首页的）、`packages/plugin-testing` 等（ADR-0033 的"推迟"表）。
- **第三方登录的字段核对**（ADR-0034 的"首批插件"）：四家的 subject、`emailVerified` 用真实账号核对一遍。

## 站点

- **统计和广告脚本、自定义 CSS**：ADR-0042 推迟，和 CSP 的关系由 ADR-0053 定了，做的时候另写 ADR。
- **CSP 的实测**（ADR-0053）：三家验证码各用官方的测试密钥在真实网络上走一遍（hCaptcha 的文档没提 `'strict-dynamic'`）；在 Cloudflare 后面、开着 Bot Fight Mode 时看控制台有没有 CSP 报错；Cloudflare Web Analytics 的自动注入会不会被拦。
- **后台覆盖翻译**（ADR-0019）：运行时把数据库里的覆盖叠在打包的消息上；首页的主标题随它可改（ADR-0032）。
- **种子数据**：`pnpm dev` 的空库要先在 `/setup` 建站。
- **日志和诊断**（ADR-0062，提议）：核心已改用 Pino；还没做的是启动器接管输出、写 `data/logs/` 和轮换的两个设置项，以及后台诊断页和诊断包。都落地后 ADR 改成已采纳。

## 发布和文档

- **发布的后续**（ADR-0040）：ZIP 和镜像加构建来源证明（`actions/attest-build-provenance`）；GHCR 的镜像在真实环境里运行一次（发布工作流冒烟的是 runner 上本地构建的 amd64 镜像）；部署文档里标了"未实测"的条目（宝塔和 1Panel 的反向代理、Windows 的 Ctrl+C 和 NSSM、Docker 里导入）在真实环境里核对；国内的下载渠道看反馈再定。
- **更新检测和一键升级**（ADR-0061）：
  - 第一次带它发布之前：建 R2 桶 `nextskin-releases` 和不开代理的 `dl` 记录，建 environment `dl`（R2 凭据），把签名私钥放进 environment `release`；发布后核对 `dl.nextskin.org/releases/v1.json`。
  - 实测一键升级和回滚：宝塔（停止、重启时三层进程）、1Panel、Windows 控制台和 NSSM（Ctrl+C 的停止顺序、命名管道、杀毒软件占着文件）、MCSManager、systemd 单元的权限分离；量一下管理进程常驻的内存。实测完改部署文档里的"未实测"。
  - 版本条目里还没有"是否含安全修复"：条目在批准发布任务时签名，那时发布说明还没写。要做的话，在打标签前给发布工作流一个输入（例如标签注释里的一行），签进条目。
- **文档站的后续**（ADR-0054）：`edge` 的 IP 在国内网络上实测；`docs/deploy` 的面板、systemd、Windows 步骤迁进文档站；玩家指南补截图；SDK 1.0 之后的版本快照。

## 维护这份文件

- 每条写缺什么、做到哪一步算完，一两行。不写经过、日期和实现细节：各版本的变化在 GitHub Release 和 `packages/plugin-sdk/CHANGELOG.md`，实现看代码和 ADR，线上部署的细节在 `apps/docs`、`apps/site` 的 README。
- 有了新的待办、或者 ADR 落地时留了没做完的部分，就加一条；做完就删。完整落地的功能不用改这份文件。
- 控制在 40 行以内。
