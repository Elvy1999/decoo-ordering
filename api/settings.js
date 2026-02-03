import { ok, fail, methodNotAllowed, supabaseServerClient, fetchSettings } from "./_shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  try {
    const supabase = supabaseServerClient();
    const settings = await fetchSettings(supabase);
    return ok(res, settings);
  } catch (err) {
    console.error("Failed to load settings:", err);
    return fail(res, 500, "SETTINGS_LOAD_FAILED", "Could not load settings.");
  }
}
