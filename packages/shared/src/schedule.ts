import type { DoseSchedule } from './types.js';

const MINUTES_PER_DAY = 24 * 60;

export interface ScheduleTime {
  hour: number;
  minute: number;
}

/**
 * Parse a 24-hour "HH:mm" string into minutes from midnight.
 */
export function parseStartTime(startTime: string): number {
  const [h, m] = startTime.split(':').map((part) => parseInt(part, 10));
  if (
    Number.isNaN(h) ||
    Number.isNaN(m) ||
    h < 0 ||
    h > 23 ||
    m < 0 ||
    m > 59
  ) {
    throw new Error(`Invalid startTime: ${startTime}`);
  }
  return h * 60 + m;
}

/**
 * Format minutes-from-midnight as a 24-hour "HH:mm" string.
 */
export function formatTime(totalMinutes: number): string {
  const wrapped = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Generate the evenly-spaced daily dose times for a schedule.
 * Spreads `timesPerDay` doses across 24 hours starting from `startTime`.
 */
export function computeScheduleTimes(schedule: Pick<DoseSchedule, 'timesPerDay' | 'startTime'>): ScheduleTime[] {
  const { timesPerDay, startTime } = schedule;
  if (timesPerDay < 1) return [];
  if (timesPerDay === 1) {
    const startMinutes = parseStartTime(startTime);
    return [{ hour: Math.floor(startMinutes / 60), minute: startMinutes % 60 }];
  }

  const intervalMinutes = MINUTES_PER_DAY / timesPerDay;
  const startMinutes = parseStartTime(startTime);
  const times: ScheduleTime[] = [];

  for (let i = 0; i < timesPerDay; i++) {
    const totalMinutes = startMinutes + Math.round(i * intervalMinutes);
    const wrapped = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    times.push({
      hour: Math.floor(wrapped / 60),
      minute: wrapped % 60,
    });
  }

  return times;
}

/**
 * Return a human-readable summary of a schedule, e.g.:
 * "10 mL, 4×/day starting 06:00, daily (06:00, 12:00, 18:00, 00:00)"
 */
export function formatScheduleSummary(
  schedule: Pick<
    DoseSchedule,
    'volumeMl' | 'timesPerDay' | 'startTime' | 'repeatEveryNDays'
  >,
): string {
  const times = computeScheduleTimes(schedule);
  const timeList = times.map((t) =>
    `${t.hour.toString().padStart(2, '0')}:${t.minute.toString().padStart(2, '0')}`,
  );
  const repeatText =
    schedule.repeatEveryNDays === 1
      ? 'daily'
      : `every ${schedule.repeatEveryNDays} days`;
  return `${schedule.volumeMl} mL, ${schedule.timesPerDay}×/day starting ${schedule.startTime}, ${repeatText} (${timeList.join(', ')})`;
}

/**
 * Compute the previous scheduled occurrence before or at `now` for a schedule.
 * Returns `null` if the schedule does not have any daily occurrences.
 */
export function getPreviousDueDate(
  schedule: Pick<DoseSchedule, 'timesPerDay' | 'startTime' | 'repeatEveryNDays'>,
  now: Date,
): Date | null {
  const times = computeScheduleTimes(schedule);
  if (times.length === 0) return null;

  const nowUtc = new Date(now.toISOString());
  const currentMinutes = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
  const currentSeconds = nowUtc.getUTCSeconds();
  const currentMs = nowUtc.getUTCMilliseconds();

  // Find the most recent time-of-day that is <= now's time-of-day.
  // If none, the previous occurrence was the last time of the previous eligible day.
  const todayMidnight = Date.UTC(
    nowUtc.getUTCFullYear(),
    nowUtc.getUTCMonth(),
    nowUtc.getUTCDate(),
  );

  let dayOffset = 0;
  let selectedTime: ScheduleTime | null = null;

  // Sort times chronologically
  const sortedTimes = [...times].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  for (let i = sortedTimes.length - 1; i >= 0; i--) {
    const t = sortedTimes[i];
    const tMinutes = t.hour * 60 + t.minute;
    if (tMinutes < currentMinutes || (tMinutes === currentMinutes && currentSeconds === 0 && currentMs === 0)) {
      selectedTime = t;
      break;
    }
  }

  if (!selectedTime) {
    selectedTime = sortedTimes[sortedTimes.length - 1];
    dayOffset = -1;
  }

  // Walk back to the most recent day that is on the repeat cycle.
  // Day 0 is the reference day. repeatEveryNDays means fire every N days.
  // For simplicity, we consider the schedule's epoch day to be the current day
  // when the schedule is created; the previous due date is the latest day <= today
  // whose offset from the epoch is a multiple of repeatEveryNDays.
  // This keeps the behaviour deterministic and avoids double-firing.
  let targetDay = dayOffset;
  const repeat = schedule.repeatEveryNDays;
  while (targetDay % repeat !== 0) {
    targetDay--;
  }

  const targetMs = todayMidnight + targetDay * 24 * 60 * 60 * 1000 + selectedTime.hour * 60 * 60 * 1000 + selectedTime.minute * 60 * 1000;
  return new Date(targetMs);
}
