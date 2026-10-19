---
'@nextskin/plugin-sdk': major
---

`ExternalIdentity` 删掉 `avatarUrl`：站内头像来自材质，核心不取第三方的头像。`LoginProvider` 的说明补上调用约定（ADR-0034）：Provider id 不超过 64 个字符、要永远对应同一个第三方；`authorizeUrl` 5 秒、`exchange` 15 秒的期限；回调带 `error` 参数时核心直接按取消处理；`subject` 是 1 到 255 个可打印的 ASCII 字符、不用登录名或邮箱；`emailVerified` 只在第三方确认过邮箱时为 true。`user.register` 拦截器的说明补上第三方登录首次建号也调用它。
