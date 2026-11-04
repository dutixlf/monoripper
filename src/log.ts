export type LogFormat = 'text' | 'json'
const maxLine = 16 * 1024

/** Runtime events carry codes and identities only; never request data or diagnostic messages. */
export function logEvent(format: LogFormat, level: 'info' | 'error', fields: Record<string, unknown>): void {
  if (format !== 'json') return
  const line = JSON.stringify({ time: new Date().toISOString(), level, component: 'monoripper', ...fields })
  if (level === 'error') console.error(line); else console.log(line)
}

export function workerLine(line: string, context: string, worker: number, stream: 'stdout' | 'stderr', truncated = false): string {
  let parsed: unknown
  if (!truncated && line.startsWith('{')) try { parsed = JSON.parse(line) } catch { /* plain text */ }
  const base = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : { time: new Date().toISOString(), level: stream === 'stderr' ? 'error' : 'info', msg: line, ...(truncated ? { truncated: true } : {}) }
  return JSON.stringify({ ...base, context, worker })
}

/** Consumes the whole stream so a chatty worker can never block on a full pipe. */
export async function pipeLines(stream: ReadableStream<Uint8Array>, write: (line: string, truncated: boolean) => void): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let skipping = false
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (skipping) skipping = false
        else if (line) write(line, false)
      }
      if (buffer.length > maxLine) {
        if (!skipping) write(buffer.slice(0, maxLine), true)
        skipping = true
        buffer = ''
      }
    }
  } catch { /* the worker exited; remaining output is lost with it */ }
  buffer += decoder.decode()
  if (buffer && !skipping) write(buffer.slice(0, maxLine), buffer.length > maxLine)
}
