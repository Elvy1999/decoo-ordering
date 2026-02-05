import { ok, fail, supabaseServerClient, fetchSettings, methodNotAllowed } from "./shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

  const RESTAURANT_LAT = Number(process.env.RESTAURANT_LAT);
  const RESTAURANT_LNG = Number(process.env.RESTAURANT_LNG);

  const checks = {
    server: true,
    env: {
      SUPABASE_URL: Boolean(supabaseUrl),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(supabaseKey),
    },
    restaurant_location: Number.isFinite(RESTAURANT_LAT) && Number.isFinite(RESTAURANT_LNG),
    supabase: false,
    settings_row: false,
    mapbox_token: true,
  };

  try {
    const supabase = supabaseServerClient();

    let settings = null;
    try {
      settings = await fetchSettings(supabase);
      checks.settings_row = Boolean(settings);
    } catch {
      console.warn("[health] settings check failed.");
    }

    try {
      const { error } = await supabase.from("menu_items").select("id").limit(1);
      if (!error) checks.supabase = true;
    } catch {
      console.warn("[health] supabase check failed.");
    }

    const deliveryEnabled = settings?.delivery_enabled === true;
    if (deliveryEnabled) checks.mapbox_token = Boolean(MAPBOX_TOKEN);

    const envOk = checks.env.SUPABASE_URL && checks.env.SUPABASE_SERVICE_ROLE_KEY;
    const okAll =
      checks.server &&
      envOk &&
      checks.restaurant_location &&
      checks.supabase &&
      checks.settings_row &&
      checks.mapbox_token;

    return ok(res, { ok: okAll, checks });
  } catch (err) {
    console.error("health failed:", err);
    return fail(res, 500, "HEALTH_FAILED", "Health check failed.");
  }
}
