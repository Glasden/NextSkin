/** 反例：import map 里没有的裸模块名 */
// @ts-expect-error 没有安装，也不应该安装
import leftPad from 'left-pad'

export default function BareImport() {
  return <p>{String(leftPad)}</p>
}
