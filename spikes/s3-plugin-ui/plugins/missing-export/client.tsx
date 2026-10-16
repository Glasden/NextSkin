/** 反例：从 react 导入宿主版本没有的名字（例如插件按更新的 React 编写） */
// @ts-expect-error 故意导入不存在的导出
import { useNotARealHook } from 'react'

export default function MissingExport() {
  return <p>{String(useNotARealHook)}</p>
}
