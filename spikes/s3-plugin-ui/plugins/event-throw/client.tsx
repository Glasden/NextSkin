import { Button } from '@nextskin/ui'

/** 事件处理函数里的错误不归 ErrorBoundary 管：组件保持原样，错误交给 window 的 error 事件 */
export default function EventThrow() {
  return (
    <Button
      data-testid="event-throw"
      onClick={() => {
        throw new Error('event-throw: 事件处理时出错')
      }}
    >
      点我抛错
    </Button>
  )
}
