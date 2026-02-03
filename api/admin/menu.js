import { ok, fail, methodNotAllowed, supabaseServerClient } from "../_shared.js";
import { requireAdmin } from "./_auth.js";

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  try {
    const supabase = supabaseServerClient();
    const { data, error } = await supabase
      .from("menu_items")
      .select("id,name,category,price_cents,badge,in_stock,is_active,sort_order")
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true });

    if (error) throw error;
    return ok(res, data || []);
  } catch (err) {
    console.error("Failed to load admin menu:", err);
    return fail(res, 500, "MENU_LOAD_FAILED", "Could not load menu.");
  }
}
