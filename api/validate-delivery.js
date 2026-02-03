import {
  ok,
  fail,
  methodNotAllowed,
  supabaseServerClient,
  fetchSettings,
  geocodeAddressMapbox,
  haversineMiles,
} from "./_shared.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  try {
    const address = (req.body?.address || "").trim();
    if (!address) {
      return fail(res, 400, "ADDRESS_REQUIRED", "Address is required.");
    }

    const supabase = supabaseServerClient();
    const settings = await fetchSettings(supabase);

    if (!settings?.delivery_enabled) {
      return fail(res, 400, "DELIVERY_DISABLED", "Delivery is unavailable right now.");
    }

    const radiusMiles = Number(settings?.delivery_radius_miles);
    if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) {
      return fail(res, 500, "RADIUS_NOT_CONFIGURED", "Delivery radius is not configured.");
    }

    const RESTAURANT_LAT = Number(process.env.RESTAURANT_LAT);
    const RESTAURANT_LNG = Number(process.env.RESTAURANT_LNG);
    if (!Number.isFinite(RESTAURANT_LAT) || !Number.isFinite(RESTAURANT_LNG)) {
      return fail(res, 500, "RESTAURANT_LOCATION_MISSING", "Restaurant location is not configured.");
    }

    const geo = await geocodeAddressMapbox(address);
    if (!geo) {
      return fail(
        res,
        400,
        "ADDRESS_NOT_FOUND",
        "Could not verify that address. Please include city and ZIP code.",
      );
    }

    const distanceMiles = haversineMiles(RESTAURANT_LAT, RESTAURANT_LNG, geo.lat, geo.lng);
    const withinRadius = distanceMiles <= radiusMiles;

    return ok(res, {
      ok: true,
      withinRadius,
      radiusMiles,
      distanceMiles: Number(distanceMiles.toFixed(2)),
      normalizedAddress: geo.place_name || "",
    });
  } catch (err) {
    console.error("validate-delivery failed:", err);
    return fail(res, 500, "DELIVERY_VALIDATE_FAILED", "Could not validate delivery address.");
  }
}
