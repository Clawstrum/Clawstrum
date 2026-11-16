import { z } from 'zod';
import { localStamp } from './context.js';

// Stored rows and tool results keep times as epoch milliseconds under names like these.
const TIME_KEY =
  /(^|_)(at|since|until|deadline|next_run|next_check)$|(At|Since|Until|Deadline)$|^next(Check|Run)$/;
const FROM = Date.UTC(2000, 0, 1);
const TO = Date.UTC(2100, 0, 1);
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;

/** Epoch-millisecond times in a tool result become local stamps with an offset, the format of the
 * prompt's clock line, because models misconvert raw epoch milliseconds (a date a day off).
 * Times inside *_json string fields are converted too, and those fields stay strings. */
export function readableTimes(value: unknown, timeZone: string): unknown {
  if (Array.isArray(value)) return value.map((v) => readableTimes(v, timeZone));
  if (!value || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  // node:sqlite rows have a null prototype.
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => {
      if (TIME_KEY.test(key) && Number.isInteger(v) && (v as number) >= FROM && (v as number) < TO)
        return [key, localStamp(v as number, timeZone)];
      if (key.endsWith('_json') && typeof v === 'string') return [key, jsonTimes(v, timeZone)];
      return [key, readableTimes(v, timeZone)];
    }),
  );
}

function jsonTimes(text: string, timeZone: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== 'object') return text;
  const converted = JSON.stringify(readableTimes(parsed, timeZone));
  return converted === JSON.stringify(parsed) ? text : converted;
}

/** A time a tool takes as input: the stamps tool results show, or epoch milliseconds. */
export const timeInput = z.union([z.number().int().nonnegative(), z.string()]);

export function inputTime(value: number | string | undefined, name: string): number | undefined {
  if (value === undefined || typeof value === 'number') return value;
  const ms = STAMP.test(value.trim()) ? Date.parse(value.trim()) : NaN;
  if (!Number.isFinite(ms))
    throw new Error(
      `${name} needs a time with an offset, like 2026-11-16T03:00:00-05:00, or epoch milliseconds`,
    );
  return ms;
}
