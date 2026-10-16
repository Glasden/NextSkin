/** 反例：没有把 react 设为外部依赖，自带了 npm 上的 react@19.3.1。hooks 调到的是另一份 React。 */
import { useState } from 'react'

export default function BundledReact() {
  const [n] = useState(1)
  return <p>bundled {n}</p>
}
