// Date and formatting helpers. Garmin reports metres, seconds and m/s.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function todayIn(timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive number of days from start to end. */
export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
}

/** Split an inclusive range into windows of at most `maxDays`. */
export function chunkRange(start: string, end: string, maxDays: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let cursor = start;
  while (cursor <= end) {
    const windowEnd = addDays(cursor, maxDays - 1);
    out.push([cursor, windowEnd < end ? windowEnd : end]);
    cursor = addDays(windowEnd, 1);
  }
  return out;
}

/** Monday of the ISO week containing `date`. */
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
}

export function round(value: unknown, digits = 1): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function km(metres: unknown): number | null {
  return typeof metres === "number" ? round(metres / 1000, 2) : null;
}

export function hms(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function minutes(seconds: unknown): number | null {
  return typeof seconds === "number" ? Math.round(seconds / 60) : null;
}

export function hours(seconds: unknown, digits = 2): number | null {
  return typeof seconds === "number" ? round(seconds / 3600, digits) : null;
}

const PACE_TYPES = /run|walk|hik|trail|treadmill|track|ultra|obstacle|snowshoe/;
const SWIM_TYPES = /swim/;

/** Speed in the unit a runner, swimmer or cyclist expects. */
export function speedLabel(metresPerSecond: unknown, activityType: string | undefined): string | null {
  if (typeof metresPerSecond !== "number" || metresPerSecond <= 0) return null;
  const type = (activityType || "").toLowerCase();
  if (SWIM_TYPES.test(type)) return `${hms(100 / metresPerSecond)} /100m`;
  if (PACE_TYPES.test(type)) return `${hms(1000 / metresPerSecond)} /km`;
  return `${round(metresPerSecond * 3.6, 1)} km/h`;
}

export function localDateOf(timestamp: unknown): string | null {
  return typeof timestamp === "string" && timestamp.length >= 10 ? timestamp.slice(0, 10) : null;
}

export function localTimeOf(timestamp: unknown): string | null {
  if (typeof timestamp === "string") return timestamp.length >= 16 ? timestamp.slice(11, 16) : null;
  if (typeof timestamp === "number") {
    // Garmin's "local" epoch fields are local wall-clock time encoded as UTC.
    return new Date(timestamp).toISOString().slice(11, 16);
  }
  return null;
}

/** Drop null/undefined fields so responses stay short. */
export function compact<T extends Record<string, unknown>>(record: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
