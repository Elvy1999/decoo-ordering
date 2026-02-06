import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireAdmin } from "./auth.js";

const BASE_FIELDS =
  "id,created_at,order_code,customer_name,customer_phone,fulfillment_type,subtotal_cents,total_cents";

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  try {
    const supabase = supabaseServerClient();
    const withStatus = `${BASE_FIELDS},status`;

    let { data, error } = await supabase
      .from("orders")
      .select(withStatus)
      .eq("payment_status", "paid")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error && typeof error.message === "string" && error.message.toLowerCase().includes("status")) {
      const fallback = await supabase
        .from("orders")
        .select(BASE_FIELDS)
        .eq("payment_status", "paid")
        .order("created_at", { ascending: false })
        .limit(50);
      if (fallback.error) throw fallback.error;
      return ok(res, fallback.data || []);
    }

    if (error) throw error;
    return ok(res, data || []);
  } catch (err) {
    console.error("Failed to load orders:", err);
    return fail(res, 500, "ORDERS_LOAD_FAILED", "Could not load orders.");
  }
}
