import {
  ok,
  fail,
  methodNotAllowed,
  supabaseServerClient,
  fetchSettings,
  geocodeAddressMapbox,
} from "./_shared.js";

function mask(value) {
  if (!value) return "";
  const s = String(value);
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  // ---- simple protection ----
  const token = req.headers["x-diag-token"];
  const expected = process.env.ADMIN_DIAG_TOKEN;

  if (!expected) {
    // safer to fail closed — forces you to configure it
    return fail(res, 500, "DIAG_NOT_CONFIGURED", "ADMIN_DIAG_TOKEN is not configured.");
  }

  if (token !== expected) {
    return fail(res, 401, "UNAUTHORIZED", "Invalid diagnostic token.");
  }

  const startedAt = Date.now();

  const diag = {
    ok: false,
    meta: {
      now: new Date().toISOString(),
      vercel_env: process.env.VERCEL_ENV || "unknown",
      region: process.env.VERCEL_REGION || "unknown",
      duration_ms: 0,
    },
    env: {
      SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      MAPBOX_TOKEN: Boolean(process.env.MAPBOX_TOKEN),
      RESTAURANT_LAT: Number.isFinite(Number(process.env.RESTAURANT_LAT)),
      RESTAURANT_LNG: Number.isFinite(Number(process.env.RESTAURANT_LNG)),
      ADMIN_DIAG_TOKEN: true, // exists if we got here
    },
    checks: {
      settings_read: false,
      menu_read: false,
      mapbox_geocode: "skipped",
    },
    data: {
      settings: null,
    },
  };

  try {
    const supabase = supabaseServerClient();

    // settings read
    const settings = await fetchSettings(supabase);
    diag.checks.settings_read = true;

    // Only return safe settings fields (no secrets anyway, but keep it minimal)
    diag.data.settings = {
      ordering_enabled: settings.ordering_enabled,
      delivery_enabled: settings.delivery_enabled,
      delivery_radius_miles: settings.delivery_radius_miles,
      processing_fee_cents: settings.processing_fee_cents,
      delivery_fee_cents: settings.delivery_fee_cents,
      delivery_min_total_cents: settings.delivery_min_total_cents,
    };

    // menu read
    const { data: menuRow, error: menuErr } = await supabase
      .from("menu_items")
      .select("id")
      .limit(1)
      .maybeSingle();

    if (!menuErr) diag.checks.menu_read = true;

    // Mapbox check (only when delivery is enabled)
    if (settings.delivery_enabled) {
      if (!process.env.MAPBOX_TOKEN) {
        diag.checks.mapbox_geocode = "failed: missing MAPBOX_TOKEN";
      } else {
        try {
          // Use a stable, generic address for diagnostics
          const testAddress = "1266 Southampton Rd, Philadelphia, PA 19116";
          const geo = await geocodeAddressMapbox(testAddress);
          diag.checks.mapbox_geocode = geo ? "ok" : "failed: no result";
        } catch (e) {
          diag.checks.mapbox_geocode = `failed: ${String(e?.message || e)}`;
        }
      }
    }

    // final ok criteria
    const okAll =
      diag.env.SUPABASE_URL &&
      diag.env.SUPABASE_SERVICE_ROLE_KEY &&
      diag.env.RESTAURANT_LAT &&
      diag.env.RESTAURANT_LNG &&
      diag.checks.settings_read &&
      diag.checks.menu_read &&
      (diag.data.settings.delivery_enabled ? String(diag.checks.mapbox_geocode).startsWith("ok") : true);

    diag.ok = Boolean(okAll);
    diag.meta.duration_ms = Date.now() - startedAt;

    // A tiny bit of masking if you ever decide to echo something later
    diag.meta.project = {
      supabase_url_hint: mask(process.env.SUPABASE_URL),
    };

    return ok(res, diag);
  } catch (err) {
    console.error("diag failed:", err);
    diag.meta.duration_ms = Date.now() - startedAt;
    return fail(res, 500, "DIAG_FAILED", "Diagnostic check failed.");
  }
}
