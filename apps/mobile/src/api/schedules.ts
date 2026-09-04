import type {
  CreateScheduleRequest,
  DoseSchedule,
  UpdateScheduleRequest,
} from '@reef/shared';
import {
  createSchedule,
  deleteSchedule,
  getSchedules,
  updateSchedule,
} from './client';

/**
 * Verified schedule mutations.
 *
 * The screen must never present a schedule as saved unless a subsequent GET
 * proves the device persisted it. These helpers perform the mutation, refetch
 * the schedule list, and verify — throwing if the change did not stick.
 */

export async function createScheduleVerified(
  baseUrl: string,
  body: CreateScheduleRequest,
): Promise<DoseSchedule[]> {
  const res = await createSchedule(baseUrl, body);
  const schedules = await getSchedules(baseUrl);
  const id = res?.schedule?.id;
  if (!id || !schedules.some((s) => s.id === id)) {
    throw new Error('Schedule was not persisted on the device — try again');
  }
  return schedules;
}

export async function updateScheduleVerified(
  baseUrl: string,
  id: string,
  body: UpdateScheduleRequest,
): Promise<DoseSchedule[]> {
  await updateSchedule(baseUrl, id, body);
  const schedules = await getSchedules(baseUrl);
  const saved = schedules.find((s) => s.id === id);
  if (!saved) {
    throw new Error('Updated schedule missing from the device — try again');
  }
  // Every field we sent must have stuck.
  for (const [key, value] of Object.entries(body)) {
    if (saved[key as keyof DoseSchedule] !== value) {
      throw new Error(`Schedule did not save correctly (${key}) — try again`);
    }
  }
  return schedules;
}

export async function deleteScheduleVerified(
  baseUrl: string,
  id: string,
): Promise<DoseSchedule[]> {
  await deleteSchedule(baseUrl, id);
  const schedules = await getSchedules(baseUrl);
  if (schedules.some((s) => s.id === id)) {
    throw new Error('Schedule was not deleted on the device — try again');
  }
  return schedules;
}
