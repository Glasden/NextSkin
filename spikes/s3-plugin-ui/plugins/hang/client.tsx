/** 反例：顶层 await 永远不完成 */
await new Promise(() => {})

export default function Hang() {
  return <p>不会出现</p>
}
