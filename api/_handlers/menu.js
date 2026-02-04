import { ok, fail, methodNotAllowed, supabaseServerClient } from "./shared.js";

export default async function handler(req, res) {
  console.log("[env]", {
    hasUrl: Boolean(process.env.SUPABASE_URL),
    hasKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  try {
    console.log("[menu] start");
    const supabase = supabaseServerClient();
    console.log("[menu] got supabase client");
    const { data, error } = await supabase
      .from("menu_items")
      .select("id,name,category,price_cents,badge,in_stock,is_active,sort_order")
      .eq("is_active", true)
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true });

    console.log("[menu] query finished", {
      hasError: Boolean(error),
      rows: data?.length,
    });
    if (error) throw error;
    return ok(res, data || []);
  } catch (err) {
    console.error("Failed to load menu:", err);
    return fail(res, 500, "MENU_LOAD_FAILED", "Could not load menu.");
  }
}
