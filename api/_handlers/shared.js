import { createClient } from "@supabase/supabase-js";

export const NAME_MIN_LEN = 1;
export const NAME_MAX_LEN = 30;
export const ADDRESS_MIN_LEN = 5;
export const ADDRESS_MAX_LEN = 60;
export const MAX_UNIQUE_ITEMS = 30;
export const MAX_ITEM_QTY = 20;
export const MAX_TOTAL_QTY = 50;
export const SETTINGS_ROW_ID = 1;

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function ok(res, body) {
  return json(res, 200, body);
}

export function fail(res, status, code, message, fields) {
  const payload = { error: { code, message } };
  if (fields) payload.error.fields = fields;
  return json(res, status, payload);
}

export function methodNotAllowed(res, allowed = ["GET"]) {
  res.setHeader("Allow", allowed.join(", "));
  return fail(res, 405, "METHOD_NOT_ALLOWED", `Use ${allowed.join(" or ")}.`);
}

export function getIP(req) {
  // Vercel sets x-forwarded-for. First IP is client.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Very simple in-memory rate limit (works per serverless instance).
const RATE_BUCKET = new Map();
export function rateLimit(req, res, { key, limit, windowMs }) {
  const ip = getIP(req);
  const now = Date.now();
  const bucketKey = `${key}:${ip}`;
  const entry = RATE_BUCKET.get(bucketKey);

  if (!entry || now > entry.resetAt) {
    RATE_BUCKET.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    fail(res, 429, "RATE_LIMITED", "Too many requests. Please try again soon.");
    return false;
  }

  entry.count += 1;
  return true;
}

export function supabaseServerClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key);
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export const digitsOnly = (phone) => String(phone || "").replace(/\D/g, "");
export function isValidPhone(phone) {
  if (!isNonEmptyString(phone)) return false;
  const trimmed = phone.trim();
  if (!/^[0-9\s()+-]+$/.test(trimmed)) return false;
  return digitsOnly(trimmed).length >= 10;
}

export function toCents(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.round(numberValue);
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export async function geocodeAddressMapbox(address) {
  const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
  if (!MAPBOX_TOKEN) throw new Error("MAPBOX_TOKEN missing");

  const query = encodeURIComponent(address);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${MAPBOX_TOKEN}&limit=1`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Mapbox geocoding failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const feature = data?.features?.[0];
  const center = feature?.center;

  if (!Array.isArray(center) || center.length < 2) return null;

  return {
    lng: Number(center[0]),
    lat: Number(center[1]),
    place_name: feature?.place_name || "",
  };
}

export async function fetchSettings(supabase) {
  const { data, error } = await supabase
    .from("settings")
    .select(
      "ordering_enabled,delivery_enabled,delivery_radius_miles,processing_fee_cents,delivery_fee_cents,delivery_min_total_cents,free_juice_enabled,free_juice_min_subtotal_cents,free_juice_item_id",
    )
    .eq("id", SETTINGS_ROW_ID)
    .single();

  if (error) throw error;
  return data;
}
