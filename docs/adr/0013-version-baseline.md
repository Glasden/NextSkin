# ADR-0013 版本基线：Node 26 LTS、Next.js ≥16.4.1、TypeScript 7

- 状态：已采纳
- 日期：2026-10-16

## 背景

截至 2026-10-16：

- Node 26 预计在本月底转为 LTS，支持到 2029-04。它是"每年两个大版本"旧节奏下的最后一个版本，从 Node 27 起改为每年一个 LTS。Node 24 即将进入维护期。
- Next.js 16.4.1 于 2026-10-14 发布，修复了 Image Optimization 的未授权 RCE（处理 SVG 时触发）和 `"use cache"` 的 RCE。16.4.0 及以前的版本都受影响。
- TypeScript 7.0（Go 原生实现）已于 2026-07 发布，类型检查速度大幅提升，对 agent 的"修改 → 验证"循环尤其有价值。
- Kysely 0.29 已经发布。从这个版本开始，迁移相关的类型要从 `kysely/migration` 导入。

## 决定

- 运行时以 **Node 26 LTS** 为基线，CI 同时跑 Node 24。发行包声明 `engines.node >= 24`。
- **Next.js ≥ 16.4.1**，锁定小版本，并订阅 Next.js 的安全公告。
- **TypeScript 7**，开启 `strict` 和 `noUncheckedIndexedAccess`。
- 依赖升级由 Renovate 定期提 PR；安全更新单独走快速通道发版。

## 后果

- 每次发版都要在发布说明里写明对应的 Node 和 Next 版本，并说明其中是否包含安全修复。服主是否及时升级，直接关系到站点的安全。
