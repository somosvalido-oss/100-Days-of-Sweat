// Health data (Apple Health Shortcut, Google Health sync) → days table
import { intOrNull, numOrNull, strOrNull } from "./util.js";

/**
 * Writes one day of health data. steps / kcal / workout minutes take the latest value from the source;
 * resting HR, weight, activity and minutes are only filled when empty, so manual entries win.
 */
export async function applyHealth(env, date, n, b) {
  const workouts = Array.isArray(b.workouts) ? b.workouts.slice(0, 20) : null;
  const wMin = intOrNull(b.workout_minutes ?? workouts?.reduce((s, w) => s + (Number(w.minutes) || 0), 0), 0, 1440);
  const firstType = strOrNull(workouts?.[0]?.type, 60) ?? strOrNull(b.workout_type, 60);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO days (date, day_number) VALUES (?, ?)").bind(date, n),
    env.DB.prepare(
      `UPDATE days SET
         steps = COALESCE(?, steps),
         active_kcal = COALESCE(?, active_kcal),
         health_workout_minutes = COALESCE(?, health_workout_minutes),
         health_workouts = COALESCE(?, health_workouts),
         resting_hr = COALESCE(resting_hr, ?),
         weight_kg = COALESCE(weight_kg, ?),
         activity = CASE WHEN (activity IS NULL OR activity='') AND ? > 0 THEN ? ELSE activity END,
         minutes = CASE WHEN minutes IS NULL AND ? > 0 THEN ? ELSE minutes END,
         updated_at = datetime('now')
       WHERE date = ?`
    ).bind(
      intOrNull(b.steps, 0), intOrNull(b.active_kcal, 0), wMin,
      workouts ? JSON.stringify(workouts) : null,
      intOrNull(b.resting_hr, 25, 220), numOrNull(b.weight_kg),
      wMin || 0, firstType || "Workout", wMin || 0, wMin, date
    ),
  ]);
}
