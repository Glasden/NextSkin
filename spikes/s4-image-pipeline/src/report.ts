import { readFile,writeFile,readdir,stat } from 'node:fs/promises';
// 报告只拼接实测 JSON，不在此脚本里重跑重负载实验。
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const e=await json('out/experiments-node24.json'),e26=await json('out/experiments-node26.json');
const b24=await json('out/bench-node24.json'),b26=await json('out/bench-node26.json');
const robustness=await json('out/robustness-node24.json'),audit=await json('out/audit.json');
const f=(n:number,d=3)=>n.toFixed(d);
const metric=(b:typeof b24,g:string,n:string,i:string)=>{const r=b.rows.find((x:{group:string;name:string;implementation:string})=>x.group===g&&x.name===n&&x.implementation===i);if(!r)throw Error(`缺基准 ${g}/${n}/${i}`);return `${f(r.median)} / ${f(r.p99)}`;};
const table=(headers:string[],rows:unknown[][])=>`| ${headers.join(' | ')} |\n| ${headers.map(()=>'---').join(' | ')} |\n${rows.map(r=>`| ${r.join(' | ')} |`).join('\n')}\n`;
const errors=[...new Set<string>(robustness.rows.map((r:{error:string})=>r.error).filter(Boolean))];
const cell=(r:{accepted:boolean;ms:number;maxRSSKiB:number;error:string;pixelsCorrect?:boolean})=>`${r.accepted?'接受':'拒绝'}${r.pixelsCorrect===false?' ⚠像素错':''} · ${f(r.ms,2)} / ${f(r.maxRSSKiB/1024,1)}${r.error?` · E${errors.indexOf(r.error)+1}`:''}`;
const baseline=robustness.rows.filter((r:{name:string})=>r.name==='empty').map((r:{maxRSSKiB:number})=>r.maxRSSKiB/1024);
const names=[...new Set<string>(robustness.rows.map((r:{name:string})=>r.name))];
const rt=table(['语料','fast-png 原样','pngjs 原样','防护 fast-png','防护 pngjs'],names.map(n=>[n,...['raw-fast','raw-pngjs','safe-fast','safe-pngjs'].map(m=>cell(robustness.rows.find((r:{name:string;mode:string})=>r.name===n&&r.mode===m)))]));
const imageNames=[...new Set<string>(b24.rows.filter((r:{group:string})=>r.group==='decode').map((r:{name:string})=>r.name))];
const decodeTable=table(['输入','24 pngjs+防护','24 fast-png+防护','24 sharp','26 pngjs+防护','26 fast-png+防护','26 sharp'],imageNames.map(n=>[n,...[b24,b26].flatMap(b=>['safe-pngjs','safe-fast-png','sharp'].map(i=>metric(b,'decode',n,i)))]));
const uploadTable=table(['输入','24 TS','24 sharp','26 TS','26 sharp'],imageNames.map(n=>[n,...[b24,b26].flatMap(b=>['TS','sharp'].map(i=>metric(b,'upload',n,i)))]));
const guardTable=table(['输入','24 原样 pngjs','24 单独防护','26 原样 pngjs','26 单独防护'],imageNames.map(n=>[n,...[b24,b26].flatMap(b=>[metric(b,'decode',n,'raw-pngjs'),metric(b,'guard',n,'guard')])]));
const renderNames=[...new Set<string>(b24.rows.filter((r:{group:string})=>r.group==='render').map((r:{name:string})=>r.name))];
const renderTable=table(['任务','24 TS+PNG','24 TS+WebP','24 sharp 对照','26 TS+PNG','26 TS+WebP','26 sharp 对照'],renderNames.map(n=>[n,...[b24,b26].flatMap(b=>['TS+PNG','TS+WebP',n.startsWith('avatar3d')||n.startsWith('body3d')?'TS+sharpPNG':'sharpPNG'].map(i=>metric(b,'render',n,i)))]));
const encodeTable=table(['Node','输入','node:zlib PNG','fast-png PNG','pngjs PNG','WASM WebP','sharp PNG'],[b24,b26].flatMap(b=>renderNames.map(n=>[b.node,n,...['node:zlib','fast-png','pngjs','WebP-WASM','sharpPNG'].map(i=>metric(b,'encode',n,i))])));
const total=e.sizes.reduce((a:{png:number;webp:number},s:{png:number;webp:number})=>({png:a.png+s.png,webp:a.webp+s.webp}),{png:0,webp:0});
const hashA=new Set(e.hashes.map((r:{A:string})=>r.A)).size,hashB=new Set(e.hashes.map((r:{B:string})=>r.B)).size;
const normalizedChanged=e.models.filter((r:{name:string;normalizedA?:string})=>r.normalizedA&&r.normalizedA!==e26.models.find((n:{name:string})=>n.name===r.name).normalizedA).map((r:{name:string})=>r.name);
const goldenNames=await readdir('golden');let goldenBytes=0;for(const name of goldenNames)goldenBytes+=(await stat(`golden/${name}`)).size;
const worst=(b:typeof b24,g:string,i:string)=>b.rows.filter((r:{group:string;implementation:string})=>r.group===g&&r.implementation===i).sort((a:{median:number},z:{median:number})=>z.median-a.median)[0];
const worstUpload=worst(b26,'upload','TS'),worstRender=worst(b26,'render','TS+PNG');
const readme=`# S4 数据报告

> 由 `npm run report` 根据 `out/` 下的实测 JSON 生成，是实施方（Codex）的原始记录。结论与取舍以 [README.md](README.md) 为准。

**实施方的结论：有条件可行。** 本机验证了不依赖 sharp 的完整 PNG 上传、规范化、hash、2D/等距 3D 渲染与无损 WebP 输出；条件是选用修正后的 pngjs、强制有界解压与元数据剥离，并将上传/渲染移入 worker 和缓存。fast-png 8 的低位深 Adam7 未通过，不能单独承担解码。最终是否采纳仍由主会话决定，本 spike 不修改 ADR。

这只验证新上传的管线；ADR-0006 要求导入材质及旧 hash 原样保留，不能经过此规范化器。对应 [ADR-0008](../../docs/adr/0008-zero-native-deps.md)。

## 运行

在本目录执行，首次需要联网下载 npm 包和 11 张材质。所有运行产物在 out/，真实与合成输入分别在 fixtures/real/、fixtures/synthetic/；黄金图由显式命令更新，测试不更新基线。

\`\`\`bash
npm ci
npm run fixtures
npm run check
npm test
npm run experiments
npm run audit
npm run bench
# 第二个版本必须等前一个基准完全结束，再运行：
S4_NODE26=/tmp/claude-1001/-workspace-NextSkin/ab258c0c-a8e5-45b8-9af9-be90c7818b8b/scratchpad/node26/bin/node
"$S4_NODE26" --import tsx src/bench.ts
"$S4_NODE26" --import tsx --test --test-concurrency=1 src/*.test.ts
"$S4_NODE26" --import tsx src/experiments.ts
npm run report
# 仅有意调整渲染后更新基线：npm run golden
\`\`\`

npm test 同时运行像素测试与完整健壮性矩阵；后者约 50 秒，每个语料/路径用独立子进程，5 秒超时。TypeScript 固定由 lockfile 安装为 7.0.2，严格模式类型检查。Node 26 路径是本机约定，其他机器自行替换；两个版本输出按版本保存。npm run report 需要两版本的 JSON 都已生成。

| 文件 | 用途 |
|---|---|
| src/png.ts | 生产候选：probe、CRC/结构/尺寸/解压防护、双解码适配、三条 PNG 编码、上传及 A/B hash |
| src/render.ts | 生产候选：模型推断、客户端预处理、最近邻/alpha 合成、通用长方体光栅器及五种预览 |
| src/webp.ts | 生产候选：Node 加载 WebP WASM，lossless + exact |
| src/fixtures.ts、src/real-manifest.json | 固定提交下载、逐文件 SHA256 校验、确定性合成 |
| src/corpus.ts、src/robustness*.ts | 颜色格式与畸形输入生成、独立子进程资源测试 |
| src/reference.ts | dev：sharp 的独立 2D UV 布局和像素对照 |
| src/pipeline.test.ts、src/security.test.ts | node:test；像素、边界、深度、黄金及 180 次隔离检查 |
| src/golden.ts、golden/*.png | 生成 ${goldenNames.length} 张黄金图，合计 ${goldenBytes} 字节 |
| src/bench.ts | tinybench 串行基准，JSON 与逐项日志 |
| src/experiments.ts、src/wasm-init.ts | hash、尺寸、像素交叉验证、独立冷启动 WASM RSS |
| src/audit.ts、src/report.ts | 生产依赖扫描、由实测 JSON 生成本报告 |
| THIRD_PARTY.md | 图像与参考代码来源、MIT 许可声明 |
| .npmrc | npm 缓存与日志固定在 out/ |

## 材质集与来源

来自 [skinview3d 固定提交 examples/public/img](https://github.com/bs-community/skinview3d/tree/84906e983a2cf325f33f515b9a71c871f799054b/examples/public/img)，提交 **84906e983a2cf325f33f515b9a71c871f799054b**，除 panorama.png 外全部 11 张 PNG。上游仓库为 MIT，许可原文保存在 [THIRD_PARTY.md](THIRD_PARTY.md)，黄金图为这些材质的衍生图。src/real-manifest.json 保存完整 SHA256，下载后校验，不在运行时信任未固定分支。初次制作 manifest 还将内容的 Git blob SHA1 与固定提交的 GitHub tree 对照。

合成集：64×32、64×64、128×128、256×256、512×512、1024×1024，每种一张真实感和一张噪声，共 12 张。真实感由 hatsune_miku 最近邻整数倍放大，64×32 取原图上半；噪声是种子 0x12345678 的 xorshift32，每个 RGBA 通道独立取低 8 位，包括随机 alpha，便于复现最差压缩情况。

## PNG 边界与像素规则

probe 只读 8 字节签名和首个 IHDR，不解压。安全解码随后限制输入 16 MiB、默认宽/高各 1024、filtered scanlines 最多 9 MiB；实际预期长度按颜色类型、位深和 Adam7 每个 pass 计算。node:zlib inflateSync(maxOutputLength=精确预期长度) 先检查，长度不符也拒绝。代价是正常图片解压两次，见后面的单独防护基准。RGBA8 最大 4 MiB；16 位中间数据最多约 8 MiB。

最多允许 4096 个块，避免小块对象数量放大内存；校验每块 CRC、IHDR 首位及唯一、IDAT 连续、PLTE/tRNS 顺序、必须有 IEND。尾随数据有意接受并丢弃。解码器只收到 IHDR/PLTE/tRNS/IDAT/IEND，其余块全部剥除，包括 tEXt/zTXt/iTXt/iCCP/gAMA/eXIf 与 APNG 控制/帧数据，避免 iCCP 的第二个解压攻击面，也保证不做颜色管理。APNG 语料含第二帧，结果仅为默认 IDAT 图像。

支持所有合法组合：灰度 1/2/4/8/16 位，RGB 8/16 位，调色板 1/2/4/8 位，灰度 alpha 与 RGBA 8/16 位，分别非隔行/Adam7，共 30 个组合。使用独立的 PNG 扫描行生成器，直接给出预期 RGBA，防止两个库犯同一个错误而互相证明。

**不能直接调用库的默认 API：**

- pngjs 7 默认 tRNS 会把 RGB 一起清零；这里对灰度/RGB 先去 tRNS，解码原始样本后自行匹配透明色，只改 alpha。
- pngjs 默认 16 位缩放是四舍五入，不是游戏的高字节截断；使用 skipRescale:true，然后每通道显式 v >>> 8。
- fast-png 非隔行低位深仍是打包数据，此处自行拆位；其 Adam7 实现不支持打包低位深，6 个组合失败。该实验适配器保留失败，不静默回退。
- fast-png 默认不校验 CRC，原始路径故意按默认行为实测；安全路径先校验原文件所有块并显式 checkCrc:true。

来源：[pngjs normaliser](https://unpkg.com/pngjs@7.0.0/lib/format-normaliser.js)、[pngjs parser](https://unpkg.com/pngjs@7.0.0/lib/parser-sync.js)、[fast-png 8 decoder](https://github.com/image-js/fast-png/blob/v8.0.0/src/png_decoder.ts)、[fast-png Adam7](https://github.com/image-js/fast-png/blob/v8.0.0/src/helpers/decode_interlace_adam7.ts)。

皮肤宽须为 64 的倍数，高等于宽或半宽；默认宽上限 1024，可下调/上调，但独立的 9 MiB 解压预算仍生效。披风接受 64×32 或 22×17 的**同一整数倍**，后者左上角对齐补透明到 64×32 的同倍尺寸，补边后的宽仍须满足上限。渲染接收已验证的 RGBA，复查尺寸形状但不重套默认 1024 上限；测试覆盖自定义 1088 上限后的旧格式皮肤和披风。46×22 等其它格式未纳入任务范围。

上传不会修改任何已解码 RGBA，包括 alpha=0 的隐藏 RGB。渲染所需的不透明修正在拷贝上进行，不回写用于规范化/hash 的像素。16 位在显式降到 RGBA8 后才保留字节；没有色彩变换。

## 健壮性实测

Node ${robustness.node}。每格为“接受/拒绝 · 耗时 ms / 峰值 RSS MiB · 错误编号”。耗时不含子进程启动/import/读文件，RSS 是 process.resourceUsage().maxRSS，**含 Node/tsx/两库的启动基线，空输入四路径为 ${f(Math.min(...baseline),1)}–${f(Math.max(...baseline),1)} MiB**，不是增量；单次冷测试，不是性能基准。全部 ${robustness.rows.length} 次均在 5 秒内结束。safe-pngjs 对 ${names.length} 个语料的接受/拒绝与预期一致，合法项逐像素一致。raw 表示未防护的库默认 API。

${rt}
${table(['编号','原始错误信息'],errors.map((x,i)=>[`E${i+1}`,x.replaceAll('|','\\|').replaceAll('\n',' ')]))}

低位深 Adam7 的防护 fast-png 拒绝属于**合法输入不兼容**，不能视为安全成功。IDAT-200MiB 语料的 IHDR 为 64×64，实际解压 209,715,200 字节；另有 Adam7 同类语料。iCCP-200MiB 的像素本身合法，安全路径直接剥除该元数据，接受是预期行为。未防护 fast-png 对 IDAT/元数据炸弹的高 RSS 和 pngjs Adam7 最终拒绝前的大内存分配，都说明只有 probe 的宽高检查不够。

完整原始结果在 out/robustness-node24.json、out/robustness-node26.json，日志保留 error、退出状态、signal、inputBytes、像素 hash。

## hash 与编码确定性

A = sha256(规范化 PNG 字节)，B = sha256(u32be(width) ‖ u32be(height) ‖ 行优先 RGBA8)。同一组含隐藏 RGB/16 位截断边界的 64×64 像素，经三个编码器 × 四个压缩等级，得到 **${hashA} 个 A，${hashB} 个 B**。共同 B 为 **${e.hashes[0].B}**。这里把不同编码器/level 当作候选规范化器比较 A；把上述 12 个文件再送入固定的正式上传规范化器，则得到 **${new Set(e.hashes.map((r:{canonicalA:string})=>r.canonicalA)).size} 个 A**，说明输入压缩方式不影响固定管线的去重。三个编码器往返都保留全部 RGBA；真实 11 张图片经两库适配解码，B 全部一致。

${table(['编码路径','level','字节','A'],e.hashes.map((r:{encoder:string;level:number;bytes:number;A:string})=>[r.encoder,r.level,r.bytes,r.A]))}

fast-png 8 实际使用纯 JS **fflate**，不是 pako；pngjs 以及自写路径使用 Node zlib。自写编码器每行枚举 PNG 0–4 滤波器，按有符号残差绝对值之和选最小，同分选小编号，level=6，只有 IHDR/IDAT/IEND。重复运行同版本编码器字节一致。Node 24 与 26 的 10 张有效皮肤/披风规范化 A ${normalizedChanged.length?`有变化：${normalizedChanged.join('、')}`:'本次全部相同'}；这不是未来 zlib 版本字节稳定的承诺。A 按现有 ADR 实现；若主会话选择 B，可降低编码器/版本变更对去重的影响，但那是单独的设计取舍，不能直接改变既有 hash。

## 模型推断、预处理与渲染

${table(['图片','尺寸','类型','推断','两库 B 一致'],e.models.map((r:{name:string;width:number;height:number;kind:string;model:string;decoderBEqual:boolean})=>[r.name,`${r.width}×${r.height}`,r.kind,r.model,r.decoderBEqual?'是':'否']))}

inferModel 的 4 个空白手臂区、全黑/全白判据依据 [skinview-utils 0.7.1](https://github.com/bs-community/skinview-utils/blob/master/src/process.ts)，直接遍历 RGBA，在基础层 alpha 修正前推断，旧格式一律 default。ears.png 是独立耳朵贴图，只测试解码，不冒充有效皮肤；3 张披风不推断手臂模型。

旧格式按 skinview-utils 的 12 个区域镜像补左臂/左腿。客户端规则在拷贝上把 (0,0)–(32,16)、(0,16)–(64,32)、(16,48)–(48,64) 强制不透明；旧帽子 (32,0)–(64,32) 若没有任何 alpha<128 的像素，整块仅清 alpha，随后恢复下半块基础层不透明，保留 RGB。所有坐标乘 width/64。

这里采用 Minecraft 客户端规则；**skinview-utils 自己的 fixOpaqueSkin 不强制基础层不透明，且按整图不透明清除叠加层，与客户端不完全相同**。alpha 的端点矩形与 <128 判据核对了 [客户端映射源码镜像](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/renderer/texture/skintexturedownloader/)，来源可信度限于第三方反编译展示；原版只支持标准尺寸，高清按比例扩展是本任务约定。

光栅器输入长方体 size/position/uv/expand/overlay，6 个面逆映射最近邻采样。不透明面用 z-buffer，叠加层的所有面（包括背面）先做不透明深度测试，再按每像素片元深度从远到近合成，避免只按长方体中心排序。头层外扩 0.5，其余 0.25；slim 手臂 3。相机固定偏航 45°、仰角 30°，顶/前/侧光照 1.0/0.85/0.7，集中在 CAMERA/LIGHT 常量。透明背景，至少 4 个整数像素边距；头像方图，全身宽为高的 3/4，2D 预览宽为高的 40/32。

UV 根据 [skinview3d 固定提交 model.ts](https://github.com/bs-community/skinview3d/blob/84906e983a2cf325f33f515b9a71c871f799054b/src/model.ts) 核对：头正面 (8,8)、人物左侧 (16,8)、帽子相应面 (40,8)/(48,8)。world +X/+Z 相机下，前脸在图左，人物左侧在图右；顶面从后向前取纹理 y。检查了纹理标注立方体、初音、Iron Man 与旧格式皮肤，未见镜像。另有非对称 UV 标记、明暗、前后透明遮挡测试。capePreview 取 (1,1,10,16) 的披风正面。

2D 使用普通 alpha over。初版双精度就近取整与 sharp 在初音半透明区域出现 1 LSB 差异；改为归一化 float32、按本机 libvips SIMD 的乘加语义后截断到字节。7 张真实皮肤 × 头像 64/128/512、正面及整张双面预览 256/512，共 ${e.cross.length} 次 sharp 逐像素比较，**全部 0 通道差异**。sharp 对照独立列 UV/布局，只共享 prepareSkin；预处理另用镜像、隐藏 RGB 与 alpha=127/128 边界断言守护。参考 [libvips composite](https://github.com/libvips/libvips/blob/v8.17.3/libvips/conversion/composite.cpp)。

黄金图 ${goldenNames.length} 张、${goldenBytes} 字节，覆盖 7 张皮肤的四种输出与 3 张披风。它们是本次实现的回归基线，**不是独立 3D 正确性 oracle**；3D 的证据是 UV 源码、定向测试和肉眼检查，尚未与客户端 GPU 截图逐像素比对。

![初音等距全身](golden/hatsune_miku-body3d.png) ![UV 定向头像](golden/1_8_texturemap_redux-avatar3d.png) ![HD 旧格式](golden/ironman_hd-body3d.png)

## 编码体积与 WASM

所有字节计数，无损 WebP 配 lossless=1、near_lossless=100、exact=1、quality=75、method=4；解码后与原始 RGBA 全通道相同（含隐藏 RGB）。PNG 三个候选均 level=6。黄金图是 PNG。

${table(['输出','node:zlib PNG','fast-png PNG','pngjs PNG','WebP','相对 node PNG 节省'],e.sizes.map((r:{name:string;png:number;fast:number;pngjs:number;webp:number})=>[r.name,r.png,r.fast,r.pngjs,r.webp,`${f((1-r.webp/r.png)*100,1)}%`]))}

总计 PNG **${total.png} B**，WebP **${total.webp} B**，节省 **${f((1-total.webp/total.png)*100,1)}%**。这是整套代表尺寸的预览，不是上传原图；每种图片同权汇总，不能外推到站点真实流量。

Node 中读取包内 WASM 为 wasmBinary，传给 encode.js 的 init，避免 fetch(file:) 不支持。先用同一个 wasm-feature-detect.simd 探测选择 webp_enc_simd.wasm 或标量 webp_enc.wasm，确保 JS 包装与二进制匹配；模块单例复用，无 canvas，无浏览器对象。依据 [jSquash Node 测试](https://github.com/jamsinclair/jSquash/blob/main/test/node/webp.test.ts) 的手工初始化机制，使用 wasmBinary override 而非依赖默认 fetch。

${table(['Node','冷初始化 ms','RSS 增量 MiB','进程 RSS 前/后 MiB'],[e,e26].map(x=>[x.node,f(x.wasm.ms),f(x.wasm.rssDelta/1048576,2),`${f(x.wasm.rssBefore/1048576,2)} / ${f(x.wasm.rssAfter/1048576,2)}`]))}

冷初始化在独立子进程测量，计入读文件、SIMD 探测、导入 glue、编译/实例化，RSS 增量来自初始化函数边界，另列更外层的前/后值，二者可能因测量边界有细微差别。WASM 二进制标量 ${e.wasm.bytes['webp_enc.wasm']} B、SIMD ${e.wasm.bytes['webp_enc_simd.wasm']} B，包需携带所支持架构的相应二进制。

**建议将 WebP 作为可选的缓存派生格式。** 本样本节省 ${f((1-total.webp/total.png)*100,1)}%，有一定带宽价值，但每个 worker 都要承担 WASM 初始化和内存，编码耗时见下表；小站只用 PNG 也足以完成管线。不要让 WASM 的加载失败阻断 PNG 上传，不建议用 WebP 替代用于 hash 的规范化 PNG。

## 基准

机器：**linux-arm64，4 核**；CPU 报告 ${b24.cpu}。版本 **${b24.node} / ${b26.node}**，sharp 0.34.5，tinybench 6.2.2。所有任务串行，两个版本也串行，不启动其它基准/重负载任务。每项预热至少 8 次/30 ms，正式至少 100 次/150 ms；表格每格均为 **中位数 / p99，毫秒**。微基准是单进程短窗口，p99 可能受 JIT/GC/宿主调度影响，不是服务端 SLO。原始样本数保存在 JSON；不包含下载、进程启动或 WASM 冷初始化。

decode 的 TS 两列含 guard + RGBA8 适配；sharp 列为解码到 RGBA，不含统一 guard，因此不能把差值全归因于解码器。原样 pngjs 列只用于衡量防护/适配代价，16 位/tRNS 默认行为并不适用于生产。fast-png 适配器已移除初次试跑发现的每像素数组分配，正式两版本使用相同解码和渲染实现；默认宽度范围的比较不受随后将内部渲染校验改为沿用已验证宽度的修正影响。自定义 1088 仅做正确性覆盖，不在性能表内。

### 解码

${decodeTable}
### 解压防护的独立开销

单独防护包含 probe、结构/CRC、拼接 IDAT、有界 inflate 与块剥离；safe decode 还会再次解压、转 RGBA，不能简单把两列相减当作全部防护成本。

${guardTable}
### 完整上传

两路径都做 guard、解码、尺寸校验/披风补边、重新编码、A+B hash；TS 自写滤波+zlib，sharp 使用 native 解码/编码。sharp 对照用于速度，不承担 16 位截断/tRNS 的规范正确性证明。对照实现强调清晰和逐像素核对，未针对 sharp 做专门的吞吐优化。

${uploadTable}
### 渲染 + 编码

输入统一为 hatsune_miku 64×64 slim。尺寸数字是头像边长/全身高度；2D 的 sharp 对照使用独立 extract/nearest resize/composite。**sharp 没有 3D 光栅 API，3D 对照复用同一个 TS rasterizer，只换 sharp PNG 编码**，不能解读为纯原生 3D 渲染性能。

${renderTable}
### 仅编码：同一 RGBA 缓冲区

${encodeTable}

Node 26 最慢上传中位数 **${f(worstUpload.median)} ms**（${worstUpload.name}，p99 ${f(worstUpload.p99)} ms），最慢 TS 渲染+PNG 中位数 **${f(worstRender.median)} ms**（${worstRender.name}，p99 ${f(worstRender.p99)} ms）。这些同步工作会直接阻塞事件循环，不能因常见 64×64 很快就放任高清/噪声上传占用主线程。

**建议：上传、规范化、渲染和编码放入有界 worker 池。** 4 核小服务器可先从 1–2 个 worker 起步，按队列和内存压测调整；此处未实现线程池/吞吐压测。缓存按材质 hash + 输出类型 + model + 尺寸 + 渲染器版本组织，优先持久缓存 128/512 头像、256/512 全身/双面预览；同一请求合并为一个生成任务。不要在每次 GET 时重新光栅化、重新初始化 WASM；WebP/PNG 分别缓存，变更 UV/光照/合成规则时提升版本键。

## 打包检查

扫描 lockfile 中全部非 dev 包的实际 node_modules 内容及 package.json：

${table(['生产包','版本','preinstall/install/postinstall'],audit.packages.map((p:{name:string;version:string})=>[p.name,p.version,'无']))}

发现 .node：**0**；binding.gyp：**0**；安装生命周期脚本：**0**。共 ${audit.packages.length} 个生产包，检查结果 out/audit.json。sharp、skinview-utils、skinview3d、tinybench、TypeScript、tsx 都是 devDependencies；sharp 和 esbuild 的原生二进制/安装脚本不进入生产依赖树。npm ci 有这两个 dev 包的安装脚本提示，本机可选预编译包仍正常加载，测试及两版本 sharp 基准均运行成功。生产入口 png.ts/render.ts/webp.ts 不 import sharp；spike 保留 fast-png 作为对比生产依赖，正式只选 pngjs 时可去掉 fast-png/fflate/iobuffer。

这验证了 Node builtin + JS + WASM 的依赖形态；没有对 Linux/Windows/macOS、x64/arm64 实际分发 ZIP 全平台运行。WASM 和库许可证也需进入正式发行清单。

## 验证记录与遗留风险

- npm ci / npm run fixtures：通过，11 张真实材质 SHA256 一致，12 张确定性合成材质。
- npx tsc -p tsconfig.json：零错误。
- npm test：Node 24 与 Node 26 都通过 10 项；180 个隔离子进程检查纳入每次测试。
- 两版本基准各完成 ${b24.rows.length} / ${b26.rows.length} 项；无任务错误。npm run experiments、npm run audit：通过。
- 初次类型检查暴露 @types/pngjs 的 PNG.sync.write 结构类型限制，已改为 PNG 实例；初版 alpha 四舍五入导致 sharp 比较失败，已修正。扩展到整张背面预览时又发现 ARM SIMD 浮点乘加的 3 个 1 LSB 差异，调整运算边界后全部通过。正式基准前中断过早期试跑（先移除 fast 适配器每像素数组分配，再补 PNG 块数上限），最终从头重跑；未把中断数据混入最终表格。
- 本次仅验证资源上限和列出的语料，不等于 PNG parser 的安全证明；输入长度限制还应在 HTTP 流读取阶段实施，本函数收到的 Buffer 已经分配。worker 还需队列上限、超时、内存/并发限制，不能用线程池替代有界解压。
- 3D 黄金图来自本实现，缺乏独立的客户端截图比对；开发正式实现前应保留这套定向用例并补充复杂透明叠加层、边界纹理的人工审查。当前相机/光照与固定站姿只用于派生预览，不支持姿态、耳朵、披风 3D、动画。
- 此机的 sharp/libvips SIMD 舍入可以逐像素匹配；其他架构/编译器的 sharp 参考结果可能有 1 LSB 差异，不能把该比较结果外推为跨平台 libvips 舍入保证。TS 自身的字节算法有固定定义。
- 编码器、zlib 或滤波规则升级可能改变 A。旧导入文件必须保持原字节；新增文件应记录管线版本。B 只是实验结果，没有擅自修改现有 ADR 的 A 决定。
- 需要正式化的部分：依赖漏洞维护、异常对外映射、worker 资源策略、全平台 WASM 初始化、协议/材质缓存接入；TS 适配/滤波没有做专门的 RGBA8 快路径或 SIMD 优化，本次测的是当前实现，不能当作纯 JS/WASM 的性能上限；spike 代码不可直接按生产标准搬入。
`;
await writeFile('REPORT.md',readme);console.log(`REPORT.md 已由实测数据生成；${b24.rows.length}+${b26.rows.length} 项基准`);
