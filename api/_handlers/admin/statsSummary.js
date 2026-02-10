import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireAdmin } from "./auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toUtcDateKey = (date) => date.toISOString().slice(0, 10);

const addUtcDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

const toUtcMidnight = (dateKey) => {
  if (!ISO_DATE_RE.test(dateKey)) return null;
  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return toUtcDateKey(parsed) === dateKey ? parsed : null;
};

const parseLocalDateKey = (dateKey) => {
  if (!ISO_DATE_RE.test(dateKey)) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const parsed = new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getStartOfUtcWeekMonday = (date) => {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = utcDate.getUTCDay();
  const distanceFromMonday = (dayOfWeek + 6) % 7;
  return addUtcDays(utcDate, -distanceFromMonday);
};

const toCents = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : 0;
};

const parseSelectedDate = (queryValue) => {
  const raw = String(queryValue || "").trim();
  if (!raw) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  return toUtcMidnight(raw);
};

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const selectedDate = parseSelectedDate(req.query?.date);
  if (!selectedDate) {
    return fail(res, 400, "INVALID_DATE", "Use date in YYYY-MM-DD format.");
  }

  const selectedDateKey = toUtcDateKey(selectedDate);
  const endExclusive = addUtcDays(selectedDate, 1);

  const selectedLocalDate =
    parseLocalDateKey(String(req.query?.date || "").trim()) || parseLocalDateKey(selectedDateKey);
  if (!selectedLocalDate) {
    return fail(res, 400, "INVALID_DATE", "Use date in YYYY-MM-DD format.");
  }

  const weekStart = getStartOfUtcWeekMonday(selectedDate);
  const monthStart = new Date(selectedLocalDate.getFullYear(), selectedLocalDate.getMonth(), 1, 0, 0, 0, 0);
  const nextMonthStart = new Date(
    selectedLocalDate.getFullYear(),
    selectedLocalDate.getMonth() + 1,
    1,
    0,
    0,
    0,
    0,
  );
  const last7Start = addUtcDays(selectedDate, -6);

  const queryStartMs = Math.min(
    selectedDate.getTime(),
    weekStart.getTime(),
    monthStart.getTime(),
    last7Start.getTime(),
  );
  const queryStart = new Date(queryStartMs);
  const queryEndExclusiveMs = Math.max(endExclusive.getTime(), nextMonthStart.getTime());
  const queryEndExclusive = new Date(queryEndExclusiveMs);

  const today = { date: selectedDateKey, ordersCount: 0, revenueCents: 0 };
  const weekToDate = { ordersCount: 0, revenueCents: 0 };
  const monthToDate = { ordersCount: 0, revenueCents: 0 };

  const last7Days = [];
  const bucketByDate = new Map();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = addUtcDays(selectedDate, -offset);
    const date = toUtcDateKey(day);
    const bucket = { date, ordersCount: 0, revenueCents: 0 };
    last7Days.push(bucket);
    bucketByDate.set(date, bucket);
  }

  const selectedStartMs = selectedDate.getTime();
  const weekStartMs = weekStart.getTime();
  const monthStartMs = monthStart.getTime();
  const monthEndExclusiveMs = nextMonthStart.getTime();
  const last7StartMs = last7Start.getTime();
  const endExclusiveMs = endExclusive.getTime();

  try {
    const supabase = supabaseServerClient();
    const { data, error } = await supabase
      .from("orders")
      .select("created_at,total_cents")
      .eq("payment_status", "paid")
      .gte("created_at", queryStart.toISOString())
      .lt("created_at", queryEndExclusive.toISOString());

    if (error) throw error;

    (data || []).forEach((order) => {
      const createdAtMs = Date.parse(order?.created_at);
      if (!Number.isFinite(createdAtMs)) return;
      if (createdAtMs < queryStartMs || createdAtMs >= endExclusiveMs) return;

      const revenueCents = toCents(order?.total_cents);
      const dateKey = toUtcDateKey(new Date(createdAtMs));

      if (createdAtMs >= selectedStartMs && createdAtMs < endExclusiveMs) {
        today.ordersCount += 1;
        today.revenueCents += revenueCents;
      }

      if (createdAtMs >= weekStartMs && createdAtMs < endExclusiveMs) {
        weekToDate.ordersCount += 1;
        weekToDate.revenueCents += revenueCents;
      }

      if (createdAtMs >= monthStartMs && createdAtMs < monthEndExclusiveMs) {
        monthToDate.ordersCount += 1;
        monthToDate.revenueCents += revenueCents;
      }

      if (createdAtMs >= last7StartMs && createdAtMs < endExclusiveMs) {
        const bucket = bucketByDate.get(dateKey);
        if (!bucket) return;
        bucket.ordersCount += 1;
        bucket.revenueCents += revenueCents;
      }
    });

    return ok(res, {
      today,
      weekToDate,
      monthToDate,
      last7Days,
      weekStartsOn: "monday",
    });
  } catch (err) {
    console.error("Failed to load admin stats summary:", err);
    return fail(res, 500, "STATS_SUMMARY_LOAD_FAILED", "Could not load stats summary.");
  }
}
