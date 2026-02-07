import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireStaff } from "./auth.js";

const ORDER_FIELDS =
  "id,order_code,customer_name,customer_phone,fulfillment_type,delivery_address,subtotal_cents,processing_fee_cents,delivery_fee_cents,discount_cents,total_cents,notes,payment_status,status,created_at,paid_at";
const ITEM_FIELDS = "order_id,item_name,qty,unit_price_cents,line_total_cents";

const toKey = (value) => String(value ?? "");

export default async function handler(req, res) {
  if (!requireStaff(req, res)) return;
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  try {
    const supabase = supabaseServerClient();
    const { data: orders, error: ordersError } = await supabase
      .from("orders")
      .select(ORDER_FIELDS)
      .or("payment_status.eq.paid,paid_at.not.is.null")
      .order("paid_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(50);

    if (ordersError) throw ordersError;

    const orderRows = Array.isArray(orders) ? orders : [];
    const orderIds = orderRows
      .map((row) => row?.id)
      .filter((id) => id !== null && id !== undefined);

    const itemsByOrderId = new Map();
    if (orderIds.length > 0) {
      const { data: items, error: itemsError } = await supabase
        .from("order_items")
        .select(ITEM_FIELDS)
        .in("order_id", orderIds)
        .order("id", { ascending: true });

      if (itemsError) throw itemsError;

      for (const item of items || []) {
        const key = toKey(item?.order_id);
        if (!itemsByOrderId.has(key)) itemsByOrderId.set(key, []);
        itemsByOrderId.get(key).push({
          item_name: item?.item_name ?? "",
          qty: Number(item?.qty || 0),
          unit_price_cents: Number(item?.unit_price_cents || 0),
          line_total_cents: Number(item?.line_total_cents || 0),
        });
      }
    }

    const enriched = orderRows.map((order) => ({
      ...order,
      items: itemsByOrderId.get(toKey(order?.id)) || [],
    }));

    return ok(res, enriched);
  } catch (err) {
    console.error("Failed to load staff orders:", err);
    return fail(res, 500, "STAFF_ORDERS_LOAD_FAILED", "Could not load staff orders.");
  }
}
