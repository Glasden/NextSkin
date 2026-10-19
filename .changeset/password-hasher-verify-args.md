---
'@nextskin/plugin-sdk': major
---

`PasswordHasherProvider.verify` 的参数去掉 `uid`：Better Auth 核对密码时只给出哈希和密码，哈希本身要带齐校验需要的信息。说明补上调用约定：只有核心认不出的哈希才交给插件、多个 Provider 的调用顺序、5 秒的期限和失败按密码不对处理、BS 去掉首尾空白之后的第二次调用、密码不能进日志和错误消息（ADR-0033）。
