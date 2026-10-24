# 部署

部署文档在文档站：<https://docs.nextskin.org/guide/install/>（宝塔面板、1Panel、Docker、systemd、Windows，反向代理与 HTTPS，配置，升级与回退）。源文件在 [`apps/docs/src/content/docs/guide/`](../../apps/docs/src/content/docs/guide/)，文档站随正式版发布，main 上新改的内容在那里先看得到。

这个目录只留 [`compose.yaml`](compose.yaml)：文档站和镜像的说明用 `https://raw.githubusercontent.com/Glasden/NextSkin/main/docs/deploy/compose.yaml` 下载它，不要挪走。
