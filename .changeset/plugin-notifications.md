---
'@nextskin/plugin-sdk': minor
'@nextskin/plugin-cli': minor
---

新增能力 `notifications.send`：`ctx.notifications.send(uid, notification, { key })` 用插件自己的文案给一个用户发站内通知，按收件人的语言渲染，正文是纯文本、链接只能是站内路径，key 永久幂等（同 key 同参数返回 `duplicate`，参数不同拒绝）；安装时按高风险展示，卸载时删掉插件发的通知。新类型 `NotificationsApi`、`PluginNotification`、`NotificationSendResult`（ADR-0052）。
