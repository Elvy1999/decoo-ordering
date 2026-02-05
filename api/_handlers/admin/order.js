import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireAdmin } from "./auth.js";

const ORDER_FIELDS =
  "id,created_at,order_code,customer_name,customer_phone,fulfillment_type,delivery_address,subtotal_cents,processing_fee_cents,delivery_fee_cents,total_cents";
const ITEM_FIELDS = "id,order_id,item_name,unit_price_cents,qty,line_total_cents";

const parseId = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;

  if (req.method === "GET") {
    const id = parseId(req.query?.id);
    if (!id) {
      return fail(res, 400, "VALIDATION_ERROR", "Order id is required.");
    }

    try {
      const supabase = supabaseServerClient();
      const withStatus = `${ORDER_FIELDS},status`;

      let { data: order, error: orderError } = await supabase
        .from("orders")
        .select(withStatus)
        .eq("id", id)
        .single();

      if (orderError && typeof orderError.message === "string" && orderError.message.toLowerCase().includes("status")) {
        const fallback = await supabase.from("orders").select(ORDER_FIELDS).eq("id", id).single();
        if (fallback.error) throw fallback.error;
        order = fallback.data;
      } else if (orderError) {
        throw orderError;
      }

      const { data: items, error: itemsError } = await supabase
        .from("order_items")
        .select(ITEM_FIELDS)
        .eq("order_id", id)
        .order("id", { ascending: true });

      if (itemsError) throw itemsError;
      return ok(res, { order, items: items || [] });
    } catch (err) {
      console.error("Failed to load order detail:", err);
      return fail(res, 500, "ORDER_LOAD_FAILED", "Could not load order.");
    }
  }

  if (req.method === "PATCH") {
    const body = req.body || {};
    const id = parseId(body.id);
    if (!id) {
      return fail(res, 400, "VALIDATION_ERROR", "Order id is required.");
    }
    if (!Object.prototype.hasOwnProperty.call(body, "status")) {
      return fail(res, 400, "VALIDATION_ERROR", "status is required.");
    }
    if (typeof body.status !== "string" || body.status.trim().length === 0) {
      return fail(res, 400, "VALIDATION_ERROR", "status must be a non-empty string.");
    }

    try {
      const supabase = supabaseServerClient();
      const { data, error } = await supabase
        .from("orders")
        .update({ status: body.status.trim() })
        .eq("id", id)
        .select("id,status")
        .single();

      if (error) {
        if (typeof error.message === "string" && error.message.toLowerCase().includes("status")) {
          return fail(res, 400, "STATUS_NOT_SUPPORTED", "Order status is not supported in this database.");
        }
        throw error;
      }

      return ok(res, data);
    } catch (err) {
      console.error("Failed to update order status:", err);
      return fail(res, 500, "ORDER_STATUS_UPDATE_FAILED", "Could not update order status.");
    }
  }

  return methodNotAllowed(res, ["GET", "PATCH"]);
}
