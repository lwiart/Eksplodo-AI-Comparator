import { DateTime } from 'luxon';
import type { Db } from '../../db/client.js';
import { enqueue, type JobInput } from './queue.js';

export type ScheduleEntry = { key: string; times: string[]; build(slot: Date): JobInput[] };

const ZONE = 'Europe/Paris';
const WINDOW_MS = 24 * 3_600_000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Valide strictement les horaires (HH 00-23, MM 00-59) ; à appeler à l'enregistrement. */
export function validateScheduleEntry(entry: ScheduleEntry): ScheduleEntry {
  for (const time of entry.times) {
    if (!TIME_RE.test(time)) throw new Error(`Heure de planification invalide pour « ${entry.key} » : ${time} (HH:MM attendu)`);
  }
  return entry;
}

/** Dernier créneau échu (heure de Paris) dans les 24 h précédant `now`, ou null. */
function latestDueSlot(times: string[], now: Date): Date | null {
  const today = DateTime.fromJSDate(now, { zone: ZONE }).startOf('day');
  let best: Date | null = null;
  for (let offset = 0; offset <= 2; offset++) {
    const day = today.minus({ days: offset });
    for (const time of times) {
      const m = TIME_RE.exec(time)!;
      const slot = DateTime.fromObject(
        { year: day.year, month: day.month, day: day.day, hour: Number(m[1]), minute: Number(m[2]) },
        { zone: ZONE },
      ).toJSDate();
      if (slot.getTime() <= now.getTime() && slot.getTime() > now.getTime() - WINDOW_MS) {
        if (!best || slot.getTime() > best.getTime()) best = slot;
      }
    }
  }
  return best;
}

/** Crée les tâches du dernier créneau échu de chaque entrée (idempotent grâce à la clé de dédoublonnage). */
export async function scheduleDueJobs(db: Db, entries: ScheduleEntry[], now: Date): Promise<number> {
  entries.forEach(validateScheduleEntry);
  let created = 0;
  for (const entry of entries) {
    const slot = latestDueSlot(entry.times, now);
    if (!slot) continue;
    for (const input of entry.build(slot)) {
      const id = await enqueue(db, { ...input, dedupeKey: `${input.type}:${entry.key}:${slot.toISOString()}` }, now);
      if (id) created++;
    }
  }
  return created;
}
