/** Format an ISO timestamp for display, falling back to the raw string on invalid dates. */
export function formatTime(iso: string): string {
  const date = new Date(iso)
  return isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/** Format a duration in milliseconds as human-readable (e.g., "1h 14m", "37m", "< 1m"). */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return '< 1m'

  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours === 0) return `${String(minutes)}m`
  if (minutes === 0) return `${String(hours)}h`
  return `${String(hours)}h ${String(minutes)}m`
}
