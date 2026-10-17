# ADR-0008 零原生依赖：node:sqlite + 纯 TS/WASM 图像管线

- 状态：已采纳（S2、S4 通过，见 `spikes/s2-node-sqlite/README.md`、`spikes/s4-image-pipeline/README.md`）
- 日期：2026-10-16

## 背景

只要依赖里有原生二进制（sharp/libvips、better-sqlite3），发行包就必须按"操作系统 × CPU 架构"分别构建，服主还可能遇到 glibc 与 musl 不匹配、Windows 上无法加载等问题。同时，libvips 是 C 代码，处理用户上传的图片本身就是攻击面。

材质的特点是尺寸很小：皮肤一般是 64×64，高清皮肤也只有几百像素见方，而且全程只需要最近邻缩放。

## 决定

### SQLite

- 使用 Node 内置的 `node:sqlite`。Node 24.21 和 26.12 上它的稳定性是 1.2（Release candidate），不输出实验性警告。better-sqlite3 同样同步执行、同样无法中断查询，换过去没有收益。
- 方言在 `packages/db` 里自己实现，不用 Better Auth 导出的 `NodeSqliteDialect`：
  - 底层用 Kysely 的 `SqliteQueryCompiler`、`SqliteAdapter`、`SqliteIntrospector`；
  - 适配层负责：参数前垫一个空对象（node:sqlite 会把第一个对象参数当成命名参数表，导致参数整体错位）；拒绝 `Date` 和 `undefined`；boolean 转 0/1；缓存预编译语句；用 `stmt.columns().length > 0` 判断是否返回行。
- 连接：一个写连接加一个读连接，都在主线程，开 WAL 和 `synchronous=normal`。事务内的查询都走写连接；事务外的 SELECT 走读连接；事务外的写语句排在写锁后面。这样开着的写事务不会挡住读。
- 读连接可以改放到 worker 线程（饱和时吞吐高约 40%，串行延迟多约 70 µs），作为大站的调优选项，默认不开。写连接不放进 worker，否则写事务延迟翻倍。
- 插件在 SQLite 模式下（ADR-0010 中遗留风险的解决方案）：
  - 插件的读查询走专用的 worker 连接。这个连接以只读方式打开，authorizer 只放行该插件的 `p_<id>__` 表。插件的慢查询因此不会阻塞核心。
  - 网关在插件查询里加入期限函数，超时中止；查询卡住时换掉这个 worker。node:sqlite 没有 `sqlite3_interrupt`，`worker.terminate()` 只有在查询会调用 JS 函数时才能及时生效。
  - 插件自己开的事务占住全局写锁，默认时限 100 ms。拦截器加入核心事务的方式不受此限。
- 其他进程写库会让主线程在 busy_timeout 内同步忙等。命令行里的写操作要么经由运行中的服务完成，要么在服务停止时执行；主线程写连接的 busy_timeout 设得短一些。
- MySQL 和 PostgreSQL 使用纯 JS 驱动（mysql2、pg 或 postgres.js）。

### 图像

- 解码前由核心自己把关：解析块并校验 CRC，按 IHDR 计算出精确的解压后长度，用 `node:zlib` 的 `inflateSync(…, { maxOutputLength })` 解压；只把 IHDR、PLTE、tRNS、IDAT、IEND 交给解码库，其余块全部丢弃。只检查宽高不够：IHDR 写 64×64 的文件也能解压出几百 MB。
- 反滤波和格式转换用 pngjs，但 16 位（取高字节，与游戏一致）和 tRNS（只改 alpha，保留 RGB）由我们显式处理。不用 fast-png：低位深的 Adam7 会解错。
- 规范化：解码为 RGBA8，所有像素原样保留，包括 alpha 为 0 的像素原有的 RGB（游戏会把基础层强制设为不透明，这些 RGB 在游戏里看得见）；不做颜色管理；用固定参数重新编码为只含 IHDR、IDAT、IEND 的 PNG。22×17 系列披风补齐到 64×32 的同倍尺寸。
- **新材质的 hash 是像素 hash**：`sha256(u32be(宽) ‖ u32be(高) ‖ RGBA8 像素)`。它与编码器无关；文件字节的 hash 会随 zlib 版本和 CPU 架构变化，导致去重失效。Minecraft 客户端只把 URL 里的 hash 当缓存键，不校验文件内容。导入的旧材质保留原 hash（ADR-0006），建议导入时另算一列像素 hash 用于去重。
- 2D 头像、2D 预览、等距 3D 渲染都自己实现，全程最近邻，预处理（旧格式转换、基础层不透明、旧帽子层修正）与游戏客户端一致，只作用在渲染用的副本上。sharp 没有 3D 光栅化能力，所以 3D 渲染无论如何都是 JS 实现。
- WebP（WASM 版 libwebp，无损）作为可选的派生格式，体积比 PNG 小约 40%，加载失败时回退到 PNG。
- 上传、渲染、编码都在 worker 池里执行，池要有队列上限和超时。渲染结果按 `(材质 hash, 输出类型, 模型, 尺寸, 渲染器版本)` 缓存，上传时预先生成常用尺寸。上传大小在读取请求体时就要限制。
- 目标：**一个 ZIP 包可以在任何装有 Node 26 的 Linux/Windows/macOS、x64/arm64 机器上运行**。

## 后果

- 发行流水线只需要构建一次。生产依赖里没有原生模块，也没有安装脚本。
- 常见的 64×64 皮肤，整个上传流程约 1.4 ms，比 sharp 还快；1024 级别的高清图慢 2–3 倍（最坏约 330 ms），只在上传时付一次，并且在 worker 里执行。
- 渲染代码必须按无分配的方式写（类型化数组，热循环里不创建对象）。S4 中逐像素分配的写法比无分配写法慢 2–23 倍。
- 3D 渲染没有独立的对照实现，靠定向测试、黄金图和人工检查守护；相机和光照参数等视觉方向确定后再调。
- Node 26.12 内置的 SQLite 3.54.0 有一个问题：node:sqlite 每次执行都会调用 `sqlite3_clear_bindings()`，这会让带 JOIN 的语句每次都重新编译，单条查询多约 7 µs。已用纯 C 复现并报告上游，SQLite 已在 check-in 535a77cf5a 修复，等待新版本发布和 Node 升级内置 SQLite。端到端影响很小。
- worker 入口文件（SQLite 读连接、插件连接、图像池）必须在 Next.js 构建后仍能找到，搭脚手架时验证。

## 不采用时的退路（保留）

- SQLite：better-sqlite3，发行包按平台分别构建。它解决不了并发问题，以上连接架构照样需要。
- 图像：sharp，同样按平台分别构建。3D 渲染仍是 JS 实现。

## 考虑过的其他方案

- **sharp + better-sqlite3**：更成熟，高清图处理快 2–3 倍，代价是多平台打包，以及 C 代码带来的攻击面。
- **SQLite 单连接（Kysely 默认做法）**：插件开着的事务会让所有查询排队，插件慢查询会拖垮整个服务（S2 中吞吐跌到五分之一）。
- **所有 SQLite 连接都放进 worker**：主线程完全不被 SQLite 阻塞，但写事务延迟翻倍，复杂度更高；核心自己的查询可控，不值得。
- **规范化 PNG 的文件 hash**：同一组像素换编码器或压缩级别，S4 中得到 9 种不同的 hash。
