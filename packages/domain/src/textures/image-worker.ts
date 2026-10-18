import { parentPort } from 'node:worker_threads'
import { DomainError } from '../errors.ts'
import { inspectTexture, processUpload, renderTexture, type RenderInput } from './image.ts'
import type { TextureType } from '@nextskin/skin'

export type ImageTask =
  | { kind: 'upload'; bytes: Uint8Array; type: TextureType }
  | { kind: 'inspect'; bytes: Uint8Array; type: TextureType }
  | { kind: 'render'; input: RenderInput }
const port = parentPort
if (!port) throw new Error('图像 worker 缺少通信端口')
port.on('message', (task: ImageTask) => {
  try {
    if (task.kind === 'inspect') {
      port.postMessage({ ok: true, result: inspectTexture(task.bytes, task.type) })
      return
    }
    const result = task.kind === 'upload' ? processUpload(task.bytes, task.type) : renderTexture(task.input)
    const bytes = result instanceof Uint8Array ? result : result.png
    port.postMessage({ ok: true, result }, [bytes.buffer as ArrayBuffer])
  } catch (error) {
    port.postMessage(
      error instanceof DomainError ? { ok: false, code: error.code, params: error.params } : { ok: false },
    )
  }
})
