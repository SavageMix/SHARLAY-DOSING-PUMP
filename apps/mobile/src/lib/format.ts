function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Locale date + short time, e.g. for the next-dose fire-time line. */
export function formatDateTime(date: Date): string {
  return `${date.toLocaleDateString()} ${formatTime(date)}`;
}

/** Compact "In HH:MM:SS" countdown for an upcoming dose. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');
  return `In ${hh}:${mm}:${ss}`;
}
