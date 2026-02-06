import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireAdmin } from "./auth.js";

const PROMO_SELECT =
  "id,code,discount_type,discount_value,min_order_cents,max_discount_cents,used_count,active,starts_at,first_order_only,note,created_at,updated_at";

export async function handleAdminPromoCodes(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  try {
    const supabase = supabaseServerClient();
    const { data, error } = await supabase
      .from("promo_codes")
      .select(PROMO_SELECT)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return ok(res, { ok: true, promo_codes: data || [] });
  } catch (err) {
    console.error("Failed to load promo codes:", err);
    return fail(res, 500, "PROMO_CODES_LOAD_FAILED", "Could not load promo codes.");
  }
}

export default handleAdminPromoCodes;
