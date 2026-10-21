# yggdrasil.serverAdmission

`yggdrasil.serverAdmission` is a failure-closed interceptor for server-specific Yggdrasil API paths.

The core owns the protocol route and passes an opaque `serverKey` to the plugin. The plugin owns the server registry and policy, such as membership, bans, and single/multiple-profile rules. The core invokes the interceptor for `metadata`, `join`, and `hasJoined` phases; a dynamic path is unavailable when no enabled interceptor can handle it.

The path is intended to look like `/api/yggdrasil/server/<serverKey>`. The key is a routing identifier, not a substitute for plugin policy or transport security.
