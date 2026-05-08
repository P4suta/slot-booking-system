/**
 * Minimal in-test WebSocket pair driver for DO upgrade testing.
 *
 * The `cloudflare:test` runtime supports `Upgrade: websocket`
 * requests against `SELF` directly — `response.webSocket` is the
 * client side of the pair, and the test asserts on its `message`
 * events through a Promise-based collector.
 *
 * Usage:
 * ```ts
 * const { socket, messages } = await openWebSocket(SELF, "/api/v1/queue/feed")
 * await driveMutation()
 * const received = await messages.next(2_000)
 * expect(received).toMatchObject({ ok: true, waitingCount: ... })
 * socket.close(1000, "test-done")
 * ```
 */

export type WebSocketHarness = {
  readonly socket: WebSocket
  readonly messages: MessageStream
  readonly close: (code?: number, reason?: string) => void
}

export type MessageStream = {
  /** Resolve with the next message or reject after `timeoutMs`. */
  next: (timeoutMs?: number) => Promise<unknown>
  /** Snapshot of all messages received so far. */
  drain: () => readonly unknown[]
}

const DEFAULT_TIMEOUT = 2_000

const buildMessageStream = (socket: WebSocket): MessageStream => {
  const buffered: unknown[] = []
  const waiters: Array<{
    resolve: (value: unknown) => void
    reject: (reason: unknown) => void
  }> = []
  socket.addEventListener("message", (event) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data as string)
    } catch {
      parsed = event.data
    }
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve(parsed)
    } else {
      buffered.push(parsed)
    }
  })
  return {
    next: (timeoutMs = DEFAULT_TIMEOUT) =>
      new Promise((resolve, reject) => {
        const buffered0 = buffered.shift()
        if (buffered0 !== undefined) {
          resolve(buffered0)
          return
        }
        const timer = setTimeout(() => {
          // Walk back through waiters and reject the matching slot
          // (in practice always the head we just registered).
          const idx = waiters.findIndex((w) => w.resolve === resolve)
          if (idx !== -1) waiters.splice(idx, 1)
          reject(new Error(`No WebSocket message within ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.push({
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        })
      }),
    drain: () => [...buffered],
  }
}

export const openWebSocket = async (
  self: { fetch: (request: Request) => Promise<Response> },
  path: string,
): Promise<WebSocketHarness> => {
  const response = await self.fetch(
    new Request(`http://example.com${path}`, {
      headers: { Upgrade: "websocket" },
    }),
  )
  if (response.status !== 101 || response.webSocket === null || response.webSocket === undefined) {
    throw new Error(
      `WebSocket upgrade expected (status 101 + webSocket field); got status ${response.status.toString()}`,
    )
  }
  const socket = response.webSocket
  socket.accept()
  const messages = buildMessageStream(socket)
  return {
    socket,
    messages,
    close: (code = 1000, reason = "test-done") => {
      socket.close(code, reason)
    },
  }
}
