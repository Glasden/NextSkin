# 部署文档的截图

`src/content/docs/guide/install/`、`guide/upgrade.md` 用的截图（`src/assets/install/`）是在真实的面板上一步步截的。面板的界面随版本变，不像插槽一览那样能自动重拍；这里记下环境怎么搭、工具怎么用、截图守哪些规矩。2026-10 用宝塔 13.1.0 和 1Panel v2.4.1 截了第一批。

| 目录 | 内容 |
| --- | --- |
| `src/assets/install/baota/`、`1panel/` | 各面板的步骤 |
| `src/assets/install/common/` | 建站和建站之后，任何安装方式都一样 |
| `src/assets/install/upgrade/` | 后台一键升级和回滚 |

## 环境

每个面板装在一个单独的 LXD 容器（Ubuntu 24.04）里：面板会改防火墙、装 Docker 和 Nginx，不能碰宿主机，做完整个删掉。

```bash
cat <<'EOF' | sudo lxd init --preseed
networks:
- name: lxdbr0
  type: bridge
  config: { ipv4.address: 10.88.0.1/24, ipv4.nat: "true", ipv6.address: none }
storage_pools:
- name: default
  driver: btrfs
  config: { size: 40GiB }
profiles:
- name: default
  devices:
    root: { path: /, pool: default, type: disk }
    eth0: { name: eth0, network: lxdbr0, type: nic }
EOF
# 宿主机开着 ufw、装了 Docker 时，容器拿不到地址、出不了网，要放行网桥（做完删掉这几条）
sudo ufw allow in on lxdbr0 comment 'LXD bridge (docs test)'
sudo ufw route allow in on lxdbr0 comment 'LXD bridge (docs test)'
sudo ufw route allow out on lxdbr0 comment 'LXD bridge (docs test)'
sudo iptables -I DOCKER-USER -i lxdbr0 -j ACCEPT
sudo iptables -I DOCKER-USER -o lxdbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

lxc launch ubuntu:24.04 ns-bt
# 1Panel 在容器里跑 Docker
lxc launch ubuntu:24.04 ns-1p -c security.nesting=true \
  -c security.syscalls.intercept.mknod=true -c security.syscalls.intercept.setxattr=true
```

装面板用官方的安装脚本，参数让它不问问题：

```bash
# 宝塔：在容器里下载 https://download.bt.cn/install/install_panel.sh
bash install_panel.sh ed8484bec -y --ssl-disable -P <端口> --safe-path <入口> -u <用户名> -p <密码>
# 1Panel：从 https://resource.fit2cloud.com/1panel/package/v2/stable/ 下载对应架构的包，核对 checksums.txt，解压后
echo cn > .selected_edition
PANEL_NON_INTERACTIVE=1 PANEL_PASSWORD=<密码> bash install.sh --lang zh --install-dir /opt --port <端口> \
  --entrance <入口> --username <用户名> --install-docker y --docker-mode auto --configure-accelerator n
```

- 宝塔第一次登录要绑定宝塔账号，只能由维护者本人在浏览器里操作。
- 装好就给容器打快照（`lxc snapshot ns-bt fresh`），步骤走错了可以回到这里。
- HTTPS 用自签证书，从面板“粘贴、上传已有证书”的入口装；免费证书的申请表单只截图、不提交（测试环境没有公网域名）：

  ```bash
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout skin.key -out skin.crt \
    -days 365 -subj "/CN=skin.example.com" -addext "subjectAltName=DNS:skin.example.com"
  ```

- 发行包照文档的步骤从 `dl.nextskin.org` 下载。要截一键升级，先装上一个正式版。

## 截图

```bash
# 终端 1：常驻的浏览器，文档里的示例域名解析到正在截的容器
NEXTSKIN_SHOTS_MAP="skin.example.com 10.88.0.206" node apps/docs/screenshots/install/browser.ts
# 终端 2：一步一个脚本
node apps/docs/screenshots/install/shoot.ts <步骤脚本> [参数…]
```

- 步骤脚本写在仓库外的临时目录里，不提交：它们只对一个面板版本有效，下次重拍时界面多半已经变了。脚本默认导出 `async (helpers) => {}`，`helpers` 的类型是 `shoot.ts` 导出的 `Helpers`：`page`、`mark`（画框和序号）、`clearMarks`、`redact`（换掉敏感文字）、`shot`（截成品）、`snap`（截临时图看页面）。一次只做一小步，用 `snap` 看结果再写下一步。
- 已经截好的图要改标注（例如序号被裁掉了），用 `annotate.ts`，不用回到面板上重走一遍。
- 浏览器的登录状态留在 `.cache/profile`，临时截图在 `.cache/snaps`。

例子，标出表单里的两项再截图：

```js
export default async ({ page, mark, clearMarks, shot }) => {
  const dialog = page.locator('.el-dialog:visible').last()
  await mark([
    { at: dialog.getByPlaceholder('URL地址'), n: 1 },
    { at: dialog.getByRole('button', { name: '确认' }), n: 2, side: 'right' },
  ])
  await shot('baota/remote-download', { element: dialog })
  await clearMarks()
}
```

## 规矩

- **视口 1280×800，像素密度 1**，和插槽一览的桌面端一样。表单比视口高时，用环境变量 `VH` 临时加高视口，或者分成两张（序号接着编）。
- **只截要看的那一块**：一个对话框、一张表单、一行列表。整页截图在文档里缩得看不清。
- **标注**：黑框加序号，序号和图下面列表的编号一一对应；框住输入框本身，不要框整行标签。序号挨着视口边缘被裁掉时，换 `side`。
- **打码**：面板地址换成 `192.0.2.10`，访客的公网 IP 换成 `203.0.113.7`，安装码换成 `XXXX-XXXX-XXXX-XXXX`（都用 `redact`）。面板的密码、证书私钥、签名私钥不能出现在图里：私钥输入框先填示意文字，截完再填真的。
- **示例值**：域名 `skin.example.com`，邮箱 `owner@example.com`，用户名“服主”。
- 页面开头写明截图用的面板版本和时间；没有实际操作过的步骤（例如提交证书申请）在页面上注明。
- 截完一张就打开看一遍：框有没有压住文字、序号有没有被裁、打码有没有漏。
