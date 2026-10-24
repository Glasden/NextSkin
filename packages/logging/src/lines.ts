/**
 * 把一个流按行切开（plugin host 的 stderr，由启动器拉起时核心的 stdout、stderr）。对方可以一直写不带换行的内容：
 * 一行攒到 `max` 个字符就交出去、截断，剩下的丢到下一个换行为止，不在内存里攒。行尾的 `\r` 去掉，空行不交出去
 */
export function lineSplitter(max: number, onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let partial = ''
  let truncated = false
  const flush = () => {
    const line = partial.replace(/\r$/, '')
    partial = ''
    if (line) onLine(line)
  }
  return {
    push(chunk) {
      const parts = chunk.split('\n')
      for (let index = 0; index < parts.length; index++) {
        if (index > 0) {
          if (!truncated) flush()
          truncated = false
        }
        if (truncated) continue
        partial += parts[index]!
        if (partial.length > max) {
          partial = partial.slice(0, max)
          flush()
          truncated = true
        }
      }
    },
    end() {
      if (!truncated) flush()
      partial = ''
      truncated = false
    },
  }
}
