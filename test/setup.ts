/**
 * happy-dom's AbortSignal.timeout schedules on its window's own setTimeout,
 * which vi.useFakeTimers() does not replace. Schedule on the global one, looked
 * up at call time, so request timeouts follow fake timers like everything else.
 */
AbortSignal.timeout = (ms: number): AbortSignal => {
  const controller = new AbortController()
  setTimeout(() => {
    controller.abort(new DOMException('signal timed out', 'TimeoutError'))
  }, ms)
  return controller.signal
}
