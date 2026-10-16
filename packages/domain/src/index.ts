// 领域用例与查询服务，按业务领域分目录（users、players、textures、closet……）。
// 写操作只能经过这里的用例：在一个事务内完成状态变更、触发拦截器、把事件写入 outbox（ADR-0004）。
export {}
