import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env";
import { GarminClient, GarminError } from "./garmin";
import {
  addDays,
  arr,
  chunkRange,
  compact,
  daysBetween,
  hms,
  hours,
  isIsoDate,
  km,
  localDateOf,
  localTimeOf,
  minutes,
  num,
  obj,
  round,
  speedLabel,
  str,
  todayIn,
  weekStart,
} from "./util";

const ACTIVITY_PAGE = 45; // Garmin's search fails above ~45 per page
const MAX_HEALTH_DAYS = 31;
const MAX_FOOD_DETAIL_DAYS = 7;
const MAX_NUTRITION_DAYS = 14; // one Garmin request per day; keeps each call inside Cloudflare's free-plan limits
const MAX_SUMMARY_DAYS = 400;
const MAX_SUMMARY_PAGES = 20;
const RAW_OUTPUT_LIMIT = 60_000;

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

const dateField = (what: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional().describe(`${what}, as YYYY-MM-DD`);

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    if (error instanceof GarminError || error instanceof RangeError) return fail(error.message);
    console.error("tool failure", error);
    return fail(`Something went wrong talking to Garmin: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resolve an optional date range against a default length, validating order and size. */
function resolveRange(env: Env, start: string | undefined, end: string | undefined, defaultDays: number, maxDays: number) {
  const today = todayIn(env.TIMEZONE);
  const endDate = end ?? (start ? addDays(start, defaultDays - 1) : today);
  const startDate = start ?? addDays(endDate, -(defaultDays - 1));
  for (const [label, value] of [["start_date", startDate], ["end_date", endDate]] as const) {
    if (!isIsoDate(value)) throw new RangeError(`${label} must be a real date in YYYY-MM-DD form.`);
  }
  if (startDate > endDate) throw new RangeError("start_date must be on or before end_date.");
  const days = daysBetween(startDate, endDate);
  if (days > maxDays) throw new RangeError(`That range is ${days} days; this tool accepts up to ${maxDays}. Split it into smaller ranges.`);
  return { startDate, endDate, today };
}

export function buildServer(env: Env): McpServer {
  const garmin = new GarminClient(env);
  const server = new McpServer(
    { name: "garmin-connect-personal", version: "1.1.0" },
    {
      instructions:
        "Read-only access to the owner's own Garmin Connect data through Garmin's official Personal API. " +
        "Distances are in km, elevation in m, durations as h:mm:ss, running pace in min/km. " +
        `Dates are YYYY-MM-DD in the owner's time zone (${env.TIMEZONE || "UTC"}). ` +
        "Use list_activities to find workouts, get_activity for one workout in depth, daily_health for sleep, HRV, " +
        "resting heart rate, Body Battery, stress and steps, training_summary for weekly or monthly volume, and " +
        "nutrition for logged food, macros against goals and hydration. " +
        "garmin_api_get reaches any other Personal API endpoint. Garmin's own derived metrics (VO2 max, recovery time, " +
        "training readiness) may be missing because Garmin does not always return them through this API.",
    },
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_activities",
    {
      title: "List activities",
      description:
        "List Garmin activities (runs, rides, swims, strength sessions and so on), newest first, with distance, time, pace, heart rate and training load. " +
        "Without dates it returns the most recent activities. Use the returned id with get_activity for detail.",
      inputSchema: z.object({
        start_date: dateField("Earliest start date, inclusive"),
        end_date: dateField("Latest start date, inclusive"),
        activity_type: z
          .string()
          .optional()
          .describe("Parent activity type key, e.g. running, cycling, swimming, walking, hiking, fitness_equipment"),
        activity_subtype: z
          .string()
          .optional()
          .describe("Subtype key, e.g. trail_running, treadmill_running, lap_swimming, strength_training, indoor_cycling"),
        search: z.string().max(100).optional().describe("Text to find in activity names"),
        limit: z.number().int().min(1).max(ACTIVITY_PAGE).optional().describe(`How many to return (default 20, max ${ACTIVITY_PAGE})`),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        for (const [label, value] of [["start_date", args.start_date], ["end_date", args.end_date]] as const) {
          if (value && !isIsoDate(value)) throw new RangeError(`${label} must be a real date in YYYY-MM-DD form.`);
        }
        const rows = await garmin.get<unknown[]>("/activitylist-service/activities/search/activities", {
          start: 0,
          limit: args.limit ?? 20,
          startDate: args.start_date,
          endDate: args.end_date,
          activityType: args.activity_type,
          activitySubType: args.activity_subtype,
          search: args.search,
        });
        const activities = arr(rows).map((row) => activityRow(obj(row)));
        return { count: activities.length, activities };
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_activity",
    {
      title: "Get activity detail",
      description:
        "Full detail for one activity: pace, grade-adjusted pace, heart rate and time in each HR zone, cadence and running dynamics, power, " +
        "training effect and load, fastest splits (1 km, mile, 5 km, 10 km, half, full), interval/segment summaries and the planned workout name.",
      inputSchema: z.object({
        activity_id: z.number().int().positive().describe("Activity id from list_activities"),
      }),
      annotations: READ_ONLY,
    },
    async ({ activity_id }) =>
      run(async () => {
        const [detailResult, workoutsResult] = await Promise.allSettled([
          garmin.get<Record<string, unknown>>(`/activity-service/activity/${activity_id}`),
          garmin.get<unknown[]>(`/activity-service/activity/${activity_id}/workouts`),
        ]);
        if (detailResult.status === "rejected") throw detailResult.reason;
        const detail = obj(detailResult.value);
        if (!Object.keys(detail).length) throw new GarminError(`Garmin returned no activity with id ${activity_id}.`);

        const summary = obj(detail.summaryDTO);
        const date = localDateOf(summary.startTimeLocal);
        // The list endpoint carries HR zones, fastest splits and VO2 max that the detail endpoint lacks.
        let listed: Record<string, unknown> = {};
        if (date) {
          try {
            const sameDay = await garmin.get<unknown[]>("/activitylist-service/activities/search/activities", {
              start: 0,
              limit: ACTIVITY_PAGE,
              startDate: date,
              endDate: date,
              excludeChildren: false,
            });
            listed = obj(arr(sameDay).find((row) => obj(row).activityId === activity_id));
          } catch {
            // optional enrichment
          }
        }
        const workouts =
          workoutsResult.status === "fulfilled" ? arr(workoutsResult.value).map((w) => str(obj(w).workoutName)).filter(Boolean) : [];
        return activityDetail(detail, listed, workouts as string[]);
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "daily_health",
    {
      title: "Daily health and recovery",
      description:
        "Day-by-day sleep (duration, stages, score, bed and wake time), overnight HRV with status and baseline, resting heart rate, " +
        "Body Battery, average stress, steps and intensity minutes. Defaults to the last 7 days; up to 31 days per call.",
      inputSchema: z.object({
        start_date: dateField("First day"),
        end_date: dateField("Last day, inclusive; defaults to today"),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const { startDate, endDate } = resolveRange(env, args.start_date, args.end_date, 7, MAX_HEALTH_DAYS);
        const range = { startDate, endDate };
        const [summaries, sleep, hrv, steps, stress] = await Promise.allSettled([
          garmin.get("/usersummary-service/v2/dailysummaries", range),
          garmin.get("/sleep-service/sleep/dailySleepSummariesByDate", range),
          garmin.get(`/hrv-service/hrv/daily/${startDate}/${endDate}`),
          collectChunks(garmin, "/usersummary-service/stats/steps/daily", startDate, endDate, 28),
          collectChunks(garmin, "/usersummary-service/stats/stress/daily", startDate, endDate, 28),
        ]);

        const days = new Map<string, Record<string, unknown>>();
        for (let d = startDate; d <= endDate; d = addDays(d, 1)) days.set(d, { date: d });
        const day = (date: unknown) => (typeof date === "string" ? days.get(date.slice(0, 10)) : undefined);
        const unavailable: string[] = [];
        const note = (label: string, result: PromiseSettledResult<unknown>) => {
          if (result.status === "rejected") unavailable.push(`${label}: ${reason(result.reason)}`);
        };
        note("daily summaries", summaries);
        note("sleep", sleep);
        note("HRV", hrv);
        note("steps", steps);
        note("stress", stress);

        if (summaries.status === "fulfilled") {
          for (const item of arr(obj(summaries.value).data)) {
            const s = obj(item);
            const target = day(s.calendarDate);
            if (!target) continue;
            const heart = obj(s.heartRate);
            const battery = obj(s.bodyBattery);
            const intensity = obj(s.intensityMinutes);
            target.resting_hr = num(heart.restingValue);
            target.body_battery = compact({
              high: num(battery.maxValue),
              low: num(battery.minValue),
              charged: num(battery.chargedValue),
              drained: num(battery.drainedValue),
              before_sleep: num(battery.endOfDayValue),
            });
            target.intensity_minutes = compact({ moderate: num(intensity.moderate), vigorous: num(intensity.vigorous) });
          }
        }
        if (sleep.status === "fulfilled") {
          for (const item of arr(sleep.value)) {
            const s = obj(item);
            const target = day(s.calendarDate);
            if (!target || !num(s.sleepTimeSeconds)) continue;
            const overall = obj(obj(s.sleepScores).overall);
            target.sleep = compact({
              total_h: hours(s.sleepTimeSeconds),
              deep_min: minutes(s.deepSleepSeconds),
              light_min: minutes(s.lightSleepSeconds),
              rem_min: minutes(s.remSleepSeconds),
              awake_min: minutes(s.awakeSleepSeconds),
              score: num(overall.value),
              quality: str(overall.qualifierKey),
              bedtime: localTimeOf(s.sleepStartTimestampLocal),
              wake: localTimeOf(s.sleepEndTimestampLocal),
              avg_hr: round(s.avgHeartRate, 0),
              avg_stress: round(s.avgSleepStress, 0),
              avg_respiration: round(s.averageRespirationValue, 1),
              awakenings: num(s.awakeCount),
            });
          }
        }
        if (hrv.status === "fulfilled") {
          for (const item of arr(obj(hrv.value).hrvSummaries)) {
            const h = obj(item);
            const target = day(h.calendarDate);
            if (!target) continue;
            const baseline = obj(h.baseline);
            target.hrv = compact({
              last_night_ms: num(h.lastNightAvg),
              weekly_avg_ms: num(h.weeklyAvg),
              status: str(h.status),
              balanced_range_ms:
                num(baseline.balancedLow) !== null && num(baseline.balancedUpper) !== null
                  ? `${baseline.balancedLow}-${baseline.balancedUpper}`
                  : null,
            });
          }
        }
        if (steps.status === "fulfilled") {
          for (const item of steps.value) {
            const s = obj(item);
            const target = day(s.calendarDate);
            if (target) target.steps = num(s.totalSteps);
          }
        }
        if (stress.status === "fulfilled") {
          for (const item of stress.value) {
            const s = obj(item);
            const target = day(s.calendarDate);
            const level = num(obj(s.values).overallStressLevel);
            if (target && level !== null && level >= 0) target.stress_avg = round(level, 0);
          }
        }

        const rows = [...days.values()].map((row) => compact(row)).reverse();
        if (unavailable.length === 5) throw new GarminError(`Garmin returned no health data. ${unavailable.join("; ")}`);
        return compact({ start_date: startDate, end_date: endDate, days: rows, unavailable });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "training_summary",
    {
      title: "Training volume summary",
      description:
        "Totals by week (Monday start), month or the whole range: number of sessions, distance, time, elevation, training load and average heart rate, " +
        "split by activity type. Defaults to the last 28 days by week; up to 400 days per call.",
      inputSchema: z.object({
        start_date: dateField("First day"),
        end_date: dateField("Last day, inclusive; defaults to today"),
        group_by: z.enum(["week", "month", "total"]).optional().describe("Period to total by (default week)"),
        activity_type: z.string().optional().describe("Only this parent activity type key, e.g. running"),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const { startDate, endDate } = resolveRange(env, args.start_date, args.end_date, 28, MAX_SUMMARY_DAYS);
        const groupBy = args.group_by ?? "week";
        const activities: Record<string, unknown>[] = [];
        let truncated = false;
        for (let page = 0; page < MAX_SUMMARY_PAGES; page++) {
          const rows = arr(
            await garmin.get("/activitylist-service/activities/search/activities", {
              start: page * ACTIVITY_PAGE,
              limit: ACTIVITY_PAGE,
              startDate,
              endDate,
              activityType: args.activity_type,
            }),
          );
          activities.push(...rows.map(obj));
          if (rows.length < ACTIVITY_PAGE) break;
          if (page === MAX_SUMMARY_PAGES - 1) truncated = true;
        }

        type Bucket = { sessions: number; distance_m: number; seconds: number; elevation_m: number; load: number; hrWeighted: number; hrSeconds: number };
        const periods = new Map<string, Map<string, Bucket>>();
        for (const a of activities) {
          const date = localDateOf(a.startTimeLocal);
          if (!date) continue;
          const period = groupBy === "week" ? weekStart(date) : groupBy === "month" ? date.slice(0, 7) : `${startDate}..${endDate}`;
          const type = str(obj(a.activityType).typeKey) ?? "other";
          const byType = periods.get(period) ?? new Map<string, Bucket>();
          periods.set(period, byType);
          const b = byType.get(type) ?? { sessions: 0, distance_m: 0, seconds: 0, elevation_m: 0, load: 0, hrWeighted: 0, hrSeconds: 0 };
          byType.set(type, b);
          const seconds = num(a.duration) ?? 0;
          b.sessions += 1;
          b.distance_m += num(a.distance) ?? 0;
          b.seconds += seconds;
          b.elevation_m += num(a.elevationGain) ?? 0;
          b.load += num(a.activityTrainingLoad) ?? 0;
          const hr = num(a.averageHR);
          if (hr !== null && seconds > 0) {
            b.hrWeighted += hr * seconds;
            b.hrSeconds += seconds;
          }
        }
        const render = (b: Bucket) =>
          compact({
            sessions: b.sessions,
            distance_km: b.distance_m > 0 ? km(b.distance_m) : null,
            time: hms(b.seconds),
            elevation_m: b.elevation_m > 0 ? Math.round(b.elevation_m) : null,
            training_load: b.load > 0 ? Math.round(b.load) : null,
            avg_hr: b.hrSeconds > 0 ? Math.round(b.hrWeighted / b.hrSeconds) : null,
          });
        const summary = [...periods.entries()]
          .sort(([a], [b]) => (a < b ? 1 : -1))
          .map(([period, byType]) => {
            const total: Bucket = { sessions: 0, distance_m: 0, seconds: 0, elevation_m: 0, load: 0, hrWeighted: 0, hrSeconds: 0 };
            const types: Record<string, unknown> = {};
            for (const [type, b] of [...byType.entries()].sort(([, x], [, y]) => y.seconds - x.seconds)) {
              types[type] = render(b);
              for (const key of Object.keys(total) as Array<keyof Bucket>) total[key] += b[key];
            }
            return { period: groupBy === "week" ? `week of ${period}` : period, total: render(total), by_type: types };
          });
        return compact({
          start_date: startDate,
          end_date: endDate,
          group_by: groupBy,
          activities_counted: activities.length,
          note: truncated ? `Stopped after ${activities.length} activities; use a shorter range for complete totals.` : null,
          periods: summary,
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "nutrition",
    {
      title: "Nutrition and hydration",
      description:
        "Food logged in Garmin Connect, day by day: calories, protein, carbs and fat against the daily goals (Garmin's goal adjusted for " +
        "activity, where it has one), totals per meal, and hydration intake, goal and sweat loss. Also averages across the days that have food logged. " +
        "Set include_foods to list each food with its amount and macros (up to 7 days). Defaults to the last 7 days; up to 14 days per call (call again for longer periods). " +
        "Only covers food logged in Garmin Connect.",
      inputSchema: z.object({
        start_date: dateField("First day"),
        end_date: dateField("Last day, inclusive; defaults to today"),
        include_foods: z.boolean().optional().describe("List individual foods per meal (default false; ranges of 7 days or less)"),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const { startDate, endDate } = resolveRange(env, args.start_date, args.end_date, 7, MAX_NUTRITION_DAYS);
        const includeFoods = args.include_foods === true;
        if (includeFoods && daysBetween(startDate, endDate) > MAX_FOOD_DETAIL_DAYS) {
          throw new RangeError(`Food-by-food detail is limited to ${MAX_FOOD_DETAIL_DAYS} days per request. Use a shorter range or leave include_foods off.`);
        }
        const dates: string[] = [];
        for (let d = startDate; d <= endDate; d = addDays(d, 1)) dates.push(d);

        const [logs, hydration] = await Promise.all([
          Promise.allSettled(
            dates.map((date) =>
              garmin.get(`/nutrition-service/food/logs/${date}`, { includeGoals: true, includeNutrition: true, includeMedia: false }),
            ),
          ),
          garmin.get(`/usersummary-service/stats/hydration/daily/${startDate}/${endDate}`).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        ]);

        const water = new Map<string, Record<string, unknown>>();
        if (hydration.ok) {
          for (const item of arr(hydration.value)) {
            const h = obj(item);
            const date = typeof h.calendarDate === "string" ? h.calendarDate.slice(0, 10) : null;
            if (!date) continue;
            const entry = compact({
              intake_ml: round(h.valueInML, 0),
              goal_ml: round(h.goalInML, 0),
              during_activity_ml: num(h.activityIntakeInML) ? round(h.activityIntakeInML, 0) : null,
              sweat_loss_ml: num(h.sweatLossInML) ? round(h.sweatLossInML, 0) : null,
            });
            if (Object.keys(entry).length) water.set(date, entry);
          }
        }

        const unavailable: string[] = [];
        if (!hydration.ok) unavailable.push(`hydration: ${reason(hydration.error)}`);
        const totals = { days: 0, calories: 0, protein: 0, carbs: 0, fat: 0 };
        const days = dates.map((date, i) => {
          const result = logs[i]!;
          if (result.status === "rejected") {
            unavailable.push(`${date}: ${reason(result.reason)}`);
            return compact({ date, hydration: water.get(date) ?? null });
          }
          const day = nutritionDay(obj(result.value), includeFoods);
          if (day.logged) {
            totals.days += 1;
            totals.calories += day.consumed.calories ?? 0;
            totals.protein += day.consumed.protein_g ?? 0;
            totals.carbs += day.consumed.carbs_g ?? 0;
            totals.fat += day.consumed.fat_g ?? 0;
          }
          return compact({
            date,
            consumed: day.logged ? compact(day.consumed) : null,
            goal: day.goal,
            meals: day.meals,
            note: day.logged ? null : "no food logged",
            hydration: water.get(date) ?? null,
          });
        });
        if (unavailable.length === dates.length + 1) throw new GarminError(`Garmin returned no nutrition data. ${unavailable.slice(0, 3).join("; ")}`);

        const avg = (sum: number) => (totals.days ? Math.round(sum / totals.days) : null);
        return compact({
          start_date: startDate,
          end_date: endDate,
          averages_per_logged_day: totals.days
            ? { days_logged: totals.days, calories: avg(totals.calories), protein_g: avg(totals.protein), carbs_g: avg(totals.carbs), fat_g: avg(totals.fat) }
            : null,
          days: days.reverse(),
          unavailable,
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "garmin_api_get",
    {
      title: "Raw Garmin API read",
      description:
        "Read any Garmin Connect Personal API endpoint not covered by the other tools and get its raw JSON (long responses are cut off). Read-only. Useful paths: " +
        "/usersummary-service/usersummary/daily?calendarDate=YYYY-MM-DD (full day summary incl. Body Battery at wake); " +
        "/sleep-service/sleep/dailySleep?date=YYYY-MM-DD; /hrv-service/hrv/YYYY-MM-DD (overnight HRV readings); " +
        "/wellness-service/wellness/dailyHeartRate?date=YYYY-MM-DD; /wellness-service/wellness/bodyBattery/reports/daily?startDate&endDate (max 31 days); " +
        "/wellness-service/wellness/daily/spo2acclimation/YYYY-MM-DD; /biometric-service/heartRateZones/v2; /userprofile-service/userprofile/settings; " +
        "/fitnessage-service/fitnessage/v2/YYYY-MM-DD; /weight-service/weight/range/START/END; /usersummary-service/stats/hydration/daily/START/END (max 31 days); " +
        "/nutrition-service/food/logs/YYYY-MM-DD; /wellnessactivity-service/activity/summary/range/START/END.",
      inputSchema: z.object({
        path: z.string().min(2).max(300).describe("API path starting with /, without the host"),
        query: z.record(z.string(), z.string()).optional().describe("Query parameters, e.g. {\"date\": \"2026-10-21\"}"),
      }),
      annotations: READ_ONLY,
    },
    async ({ path, query }) =>
      run(async () => {
        if (/^\/(personalapitoken|download)-service\//.test(path)) {
          throw new RangeError("That endpoint isn't available through this tool.");
        }
        const data = await garmin.get(path, query ?? {});
        const text = JSON.stringify(data);
        if (text.length <= RAW_OUTPUT_LIMIT) return data;
        return { truncated: true, note: `Response was ${text.length} characters; showing the first ${RAW_OUTPUT_LIMIT}. Narrow the date range for complete data.`, partial_json: text.slice(0, RAW_OUTPUT_LIMIT) };
      }),
  );

  return server;
}

// ---- shaping ----------------------------------------------------------------

function activityRow(a: Record<string, unknown>) {
  const type = str(obj(a.activityType).typeKey) ?? undefined;
  const event = str(obj(a.eventType).typeKey);
  return compact({
    id: num(a.activityId),
    start: typeof a.startTimeLocal === "string" ? a.startTimeLocal.slice(0, 16).replace("T", " ") : null,
    name: str(a.activityName),
    type,
    race: event === "race" ? true : null,
    distance_km: num(a.distance) ? km(a.distance) : null,
    time: hms(a.duration),
    pace: speedLabel(a.averageSpeed, type),
    avg_hr: round(a.averageHR, 0),
    max_hr: round(a.maxHR, 0),
    elevation_gain_m: round(a.elevationGain, 0),
    training_load: round(a.activityTrainingLoad, 0),
    aerobic_te: round(a.aerobicTrainingEffect, 1),
    anaerobic_te: round(a.anaerobicTrainingEffect, 1),
    te_label: str(a.trainingEffectLabel),
    pr: a.isPR === true ? true : null,
  });
}

const FEEL = ["very weak", "weak", "normal", "strong", "very strong"];

function activityDetail(detail: Record<string, unknown>, listed: Record<string, unknown>, workouts: string[]) {
  const s = obj(detail.summaryDTO);
  const type = str(obj(detail.activityTypeDTO).typeKey) ?? undefined;
  const feel = num(s.directWorkoutFeel);
  const rpe = num(s.directWorkoutRpe);

  const zones: Record<string, number> = {};
  for (let zone = 1; zone <= 5; zone++) {
    const seconds = num(listed[`hrTimeInZone_${zone}`]);
    if (seconds !== null) zones[`z${zone}_min`] = round(seconds / 60, 1) ?? 0;
  }
  const fastest: Record<string, string> = {};
  for (const [field, label] of [
    ["fastestSplit_1000", "1k"],
    ["fastestSplit_1609", "mile"],
    ["fastestSplit_5000", "5k"],
    ["fastestSplit_10000", "10k"],
    ["fastestSplit_21098", "half"],
    ["fastestSplit_42195", "marathon"],
  ] as const) {
    const value = hms(listed[field]);
    if (value) fastest[label] = value;
  }

  const segments = arr(detail.splitSummaries)
    .map((item) => {
      const x = obj(item);
      return compact({
        kind: str(x.splitType),
        count: num(x.noOfSplits),
        distance_km: num(x.distance) ? km(x.distance) : null,
        time: hms(x.duration),
        pace: speedLabel(x.averageSpeed, type),
        avg_hr: round(x.averageHR, 0),
        max_hr: round(x.maxHR, 0),
      });
    })
    .filter((x) => Object.keys(x).length > 1);

  return compact({
    id: num(detail.activityId),
    name: str(detail.activityName),
    type,
    event: str(obj(detail.eventTypeDTO).typeKey),
    location: str(detail.locationName),
    description: str(detail.description),
    planned_workout: workouts[0] ?? null,
    start: typeof s.startTimeLocal === "string" ? s.startTimeLocal.slice(0, 16).replace("T", " ") : null,
    distance_km: num(s.distance) ? km(s.distance) : null,
    time: hms(s.duration),
    moving_time: hms(s.movingDuration),
    elapsed_time: hms(s.elapsedDuration),
    pace: speedLabel(s.averageSpeed, type),
    moving_pace: speedLabel(s.averageMovingSpeed, type),
    grade_adjusted_pace: speedLabel(s.avgGradeAdjustedSpeed, type),
    best_pace: speedLabel(s.maxSpeed, type),
    heart_rate: compact({ avg: round(s.averageHR, 0), max: round(s.maxHR, 0), min: round(s.minHR, 0), recovery: num(s.recoveryHeartRate) }),
    hr_time_in_zones: zones,
    cadence_spm: round(num(listed.averageRunningCadenceInStepsPerMinute) ?? s.averageRunCadence, 0),
    max_cadence_spm: round(num(listed.maxRunningCadenceInStepsPerMinute) ?? s.maxRunCadence, 0),
    running_dynamics: compact({
      stride_length_cm: round(s.strideLength, 1),
      ground_contact_ms: round(s.groundContactTime, 0),
      vertical_oscillation_cm: round(s.verticalOscillation, 1),
      vertical_ratio_pct: round(s.verticalRatio, 1),
    }),
    power_w: compact({ avg: round(s.averagePower, 0), max: round(s.maxPower, 0), normalized: round(s.normalizedPower, 0) }),
    elevation_m: compact({ gain: round(s.elevationGain, 0), loss: round(s.elevationLoss, 0), max: round(s.maxElevation, 0), min: round(s.minElevation, 0) }),
    training_effect: compact({
      aerobic: round(s.trainingEffect, 1),
      anaerobic: round(s.anaerobicTrainingEffect, 1),
      label: str(s.trainingEffectLabel),
      aerobic_message: str(s.aerobicTrainingEffectMessage),
      anaerobic_message: str(s.anaerobicTrainingEffectMessage),
    }),
    training_load: round(s.activityTrainingLoad, 0),
    vo2max: num(listed.vO2MaxValue),
    stamina_pct: compact({ start: round(s.beginPotentialStamina, 0), end: round(s.endPotentialStamina, 0) }),
    body_battery_change: num(s.differenceBodyBattery),
    perceived_effort: rpe !== null ? round(rpe / 10, 0) : null,
    feel: feel !== null ? FEEL[Math.min(4, Math.max(0, Math.round(feel / 25)))] : null,
    calories: round(s.calories, 0),
    avg_temperature_c: round(s.averageTemperature, 0),
    avg_respiration: round(s.avgRespirationRate, 1),
    fastest_splits: fastest,
    segments,
  });
}

type Macros = {
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
};

function macros(content: Record<string, unknown>, multiplier = 1): Macros {
  const scaled = (value: unknown, digits: number) => {
    const n = num(value);
    return n === null ? null : round(n * multiplier, digits);
  };
  return { calories: scaled(content.calories, 0), protein_g: scaled(content.protein, 1), carbs_g: scaled(content.carbs, 1), fat_g: scaled(content.fat, 1) };
}

function nutritionDay(summary: Record<string, unknown>, includeFoods: boolean) {
  const consumed = macros(obj(summary.dailyNutritionContent));
  const g = obj(summary.dailyNutritionGoals);
  const goal = compact({
    calories: num(g.adjustedCalories) ?? num(g.calories),
    protein_g: round(num(g.adjustedProtein) ?? num(g.protein), 0),
    carbs_g: round(num(g.adjustedCarbs) ?? num(g.carbs), 0),
    fat_g: round(num(g.adjustedFat) ?? num(g.fat), 0),
  });

  const meals = arr(summary.mealDetails)
    .map(obj)
    .filter((m) => arr(m.loggedFoods).length > 0 || (num(obj(m.mealNutritionContent).calories) ?? 0) > 0)
    .sort((a, b) => (num(obj(a.meal).displayOrder) ?? 99) - (num(obj(b.meal).displayOrder) ?? 99))
    .map((m) => {
      const meal = obj(m.meal);
      const foods = includeFoods
        ? arr(m.loggedFoods).map((item) => {
            const f = obj(item);
            const meta = obj(f.foodMetaData);
            const content = obj(f.nutritionContent);
            const servings = num(f.servingQty) ?? 1;
            const unit = str(content.servingUnit);
            const units = num(content.numberOfUnits);
            return compact({
              food: str(meta.foodName) ?? (f.logCategory === "QUICK_ADD" ? "Quick add" : "Unnamed food"),
              brand: str(meta.brandName),
              amount: unit ? `${round(servings * (units ?? 1), 2)} ${unit}` : `${round(servings, 2)} serving${servings === 1 ? "" : "s"}`,
              ...macros(content, servings),
            });
          })
        : null;
      return compact({
        meal: str(meal.mealName) ?? str(meal.defaultMealName) ?? "Meal",
        ...macros(obj(m.mealNutritionContent)),
        foods,
      });
    });

  const logged = meals.length > 0 || (consumed.calories ?? 0) > 0;
  return { logged, consumed, goal, meals };
}

async function collectChunks(garmin: GarminClient, prefix: string, start: string, end: string, maxDays: number): Promise<unknown[]> {
  const parts = await Promise.all(chunkRange(start, end, maxDays).map(([a, b]) => garmin.get(`${prefix}/${a}/${b}`)));
  return parts.flatMap((part) => arr(part));
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
