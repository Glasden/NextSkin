import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import type { TextureType } from '@nextskin/skin'
import { DomainError } from '../errors.ts'
import type { RenderInput, UploadImage } from './image.ts'
import type { ImageTask } from './image-worker.ts'

export interface ImagePool {
  /** 转移 bytes 的底层 ArrayBuffer 所有权；调用后不要继续读取。 */
  processUpload(input: { bytes: Uint8Array; type: TextureType }): Promise<UploadImage>
  render(input: RenderInput): Promise<Uint8Array>
  close(): Promise<void>
}
interface Pending {
  input: ImageTask
  resolve(value: UploadImage | Uint8Array): void
  reject(error: Error): void
}
interface Slot {
  worker?: Worker
  task?: Pending
  timer?: ReturnType<typeof setTimeout>
}
interface Reply {
  ok: boolean
  result: UploadImage | Uint8Array
  code?: string
  params?: Readonly<Record<string, string | number>>
}

export function createImagePool(options: { size?: number; queueLimit?: number; timeoutMs?: number } = {}): ImagePool {
  const size = options.size ?? Math.max(1, Math.min(4, availableParallelism() - 1))
  const queueLimit = options.queueLimit ?? 64,
    timeoutMs = options.timeoutMs ?? 10_000
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    !Number.isSafeInteger(queueLimit) ||
    queueLimit < 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new RangeError('图像池的大小、队列上限或超时不合法')
  }
  const slots: Slot[] = Array.from({ length: size }, () => ({})),
    queue: Pending[] = []
  const terminating = new Set<Promise<number>>()
  let closed = false
  function terminate(slot: Slot) {
    const worker = slot.worker
    slot.worker = undefined
    if (!worker) return
    const promise = worker.terminate()
    terminating.add(promise)
    void promise.finally(() => terminating.delete(promise))
  }
  function finish(slot: Slot, error?: Error, result?: UploadImage | Uint8Array) {
    clearTimeout(slot.timer)
    const task = slot.task
    slot.task = undefined
    if (task) {
      if (error) task.reject(error)
      else task.resolve(result!)
    }
    slot.worker?.unref()
  }
  function fail(slot: Slot, worker: Worker, error: Error) {
    if (slot.worker !== worker) return
    finish(slot, error)
    terminate(slot)
    drain()
  }
  function start(slot: Slot, task: Pending) {
    slot.task = task
    try {
      if (!slot.worker) {
        const worker = new Worker(new URL('./image-worker.ts', import.meta.url), { workerData: {} })
        slot.worker = worker
        worker.on('message', (reply: Reply) => {
          if (slot.worker !== worker || !slot.task) return
          const error = reply.ok
            ? undefined
            : reply.code
              ? new DomainError(reply.code, reply.params)
              : new Error('图像处理失败')
          finish(slot, error, reply.result)
          drain()
        })
        worker.on('error', () => fail(slot, worker, new Error('图像 worker 执行失败')))
        worker.on('exit', () => fail(slot, worker, new Error('图像 worker 已退出')))
      }
      const worker = slot.worker
      worker.ref()
      slot.timer = setTimeout(() => fail(slot, worker, new DomainError('service_unavailable')), timeoutMs)
      const bytes = task.input.kind === 'upload' ? task.input.bytes : task.input.input.bytes
      worker.postMessage(task.input, [bytes.buffer as ArrayBuffer])
    } catch {
      finish(slot, new Error('无法启动图像任务或转移字节'))
      terminate(slot)
      drain()
    }
  }
  function drain() {
    if (closed) return
    for (const slot of slots) {
      if (!slot.task && queue.length) start(slot, queue.shift()!)
    }
  }
  function submit(input: ImageTask): Promise<UploadImage | Uint8Array> {
    if (closed) return Promise.reject(new DomainError('service_unavailable'))
    const idle = slots.find((slot) => !slot.task)
    if (!idle && queue.length >= queueLimit) return Promise.reject(new DomainError('service_unavailable'))
    return new Promise((resolve, reject) => {
      const task = { input, resolve, reject }
      if (idle) start(idle, task)
      else queue.push(task)
    })
  }
  return {
    processUpload: (input) => submit({ kind: 'upload', ...input }) as Promise<UploadImage>,
    render: (input) => submit({ kind: 'render', input }) as Promise<Uint8Array>,
    async close() {
      closed = true
      for (const task of queue.splice(0)) task.reject(new DomainError('service_unavailable'))
      for (const slot of slots) {
        finish(slot, new DomainError('service_unavailable'))
        terminate(slot)
      }
      await Promise.all(terminating)
    },
  }
}
