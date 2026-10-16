import { use } from 'react'

/** 反例：模块正常加载，组件自己 use() 一个永不完成的 Promise */
const never = new Promise<never>(() => {})

export default function SuspendForever() {
  return use(never)
}
