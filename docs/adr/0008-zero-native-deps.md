# ADR-0008 零原生依赖：node:sqlite + 纯 TS/WASM 图像管线

- 状态：待验证（S2、S4）
- 日期：2026-10-16

## 背景

只要依赖里有原生二进制（sharp/libvips、better-sqlite3），发行包就必须按"操作系统 × CPU 架构"分别构建，服主还可能遇到 glibc 与 musl 不匹配、Windows 上无法加载等问题。同时，libvips 是 C 代码，处理用户上传的图片本身就是攻击面。

材质的特点是尺寸很小：皮肤一般是 64×64，高清皮肤也只有几百像素见方，而且全程只需要最近邻缩放。

## 决定

- SQLite 使用 Node 内置的 `node:sqlite`。Kysely 没有官方的 node:sqlite 方言；Better Auth 的 `@better-auth/kysely-adapter/node-sqlite-dialect` 导出了一个 `NodeSqliteDialect`，S1、S5 两个 spike 都用它在 Kysely 0.29.6 上跑通了事务、upsert 和迁移。退路是自己写一层很薄的适配（Kysely 需要的语句接口里，只有 `reader` 属性需要用 `stmt.columns().length > 0` 来补）。
- MySQL 和 PostgreSQL 使用纯 JS 驱动（mysql2、pg 或 postgres.js）。
- 图像管线用纯 TS/WASM 实现：
  - PNG 解码和编码用纯 JS 库；
  - 2D 头像和等距 3D 预览自己实现，全程最近邻；
  - WebP 输出用 WASM 编码器；
  - 解码前先读 PNG 头部的宽高，超出上限直接拒绝，防止解压炸弹；
  - 上传只接受 PNG。
- 目标：**一个 ZIP 包可以在任何装有 Node 26 的 Linux/Windows/macOS、x64/arm64 机器上运行**。

## 后果

- 发行流水线只需要构建一次。
- 图像处理速度比 libvips 慢。对小尺寸材质这应该在毫秒级，需要 S4 用真实材质集做基准测试，并对生成的头像和预览做像素级的黄金测试。
- `node:sqlite` 的稳定程度和写入并发表现需要 S2 验证。S5 已经暴露两点：它在主线程同步执行，慢查询会阻塞事件循环；Kysely 的 SQLite 方言只有一个连接，同一时刻只能有一个事务。S2 要评估把读查询（至少是插件查询）放到 worker 线程里的独立连接上。

## 不通过时

- S2 不通过：改用 better-sqlite3，发行包按平台分别构建。
- S4 不通过：改用 sharp，同样按平台分别构建。其他决定不受影响。

## 考虑过的其他方案

- **sharp + better-sqlite3**：更成熟、更快，代价是多平台打包，以及 C 代码带来的攻击面。
