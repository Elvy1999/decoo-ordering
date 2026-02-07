import crypto from "crypto";
import {
  ok,
  fail,
  json,
  methodNotAllowed,
  supabaseServerClient,
  isNonEmptyString,
} from "../../_handlers/shared.js";

const CLOVER_ECOMM_BASE = "https://scl.clover.com";

const formatCents = (value) => {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents)) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
};

const responseSnippet = (value, max = 300) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, max);
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
};

const buildOrderNote = (order) => {
  const type = String(order.fulfillment_type || "").toUpperCase() || "-";
  return [
    `ONLINE ORDER: ${order.order_code || "-"}`,
    `Promo: ${order.promo_code || "-"}`,
    `Type: ${type}`,
    `Name: ${order.customer_name || "-"}`,
    `Phone: ${order.customer_phone || "-"}`,
    `Address: ${order.delivery_address || "-"}`,
    "---",
    `Subtotal: ${formatCents(order.subtotal_cents)}`,
    `Processing fee: ${formatCents(order.processing_fee_cents)}`,
    `Delivery fee: ${formatCents(order.delivery_fee_cents)}`,
    `Discount: -${formatCents(order.discount_cents)}`,
    `Total: ${formatCents(order.total_cents)}`,
  ].join("\n");
};

const createIdempotencyKey = () => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const fetchJson = async (url, options) => {
  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => null);
  return { resp, data };
};

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const toNullableNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const normalizeReason = (reason) => {
  if (!reason) return "PAYMENT_DECLINED";
  const text = String(reason).trim();
  if (!text) return "PAYMENT_DECLINED";
  const normalized = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return normalized || "PAYMENT_DECLINED";
};

const paymentRequired = (res, details) => {
  const payload = {
    error: {
      code: "PAYMENT_REQUIRED",
      reason: normalizeReason(details?.reason),
      order_id: details?.order_id ?? null,
      computed_total_cents:
        details?.computed_total_cents === null || details?.computed_total_cents === undefined
          ? null
          : toNumber(details.computed_total_cents),
      client_total_cents:
        details?.client_total_cents === null || details?.client_total_cents === undefined
          ? null
          : toNumber(details.client_total_cents),
      is_paid: typeof details?.is_paid === "boolean" ? details.is_paid : null,
    },
  };

  console.error("[payment] PAYMENT_REQUIRED", payload.error);
  return json(res, 402, payload);
};

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!req.body || typeof req.body !== "object") {
    return fail(res, 400, "VALIDATION_ERROR", "Invalid request body.");
  }

  const rawOrderId = req.body?.order_id ?? req.body?.orderId ?? "";
  const orderId = String(rawOrderId).trim();

  const rawSourceId = req.body?.source_id ?? req.body?.sourceId ?? "";
  const sourceId = String(rawSourceId).trim();
  const clientTotalCents = toNullableNumber(req.body?.total_cents ?? req.body?.totalCents);

  if (!isNonEmptyString(orderId)) {
    return fail(res, 400, "VALIDATION_ERROR", "order_id is required.");
  }
  if (!isNonEmptyString(sourceId) || !sourceId.startsWith("clv_")) {
    return paymentRequired(res, {
      reason: "MISSING_PAYMENT_TOKEN",
      order_id: orderId || null,
      computed_total_cents: null,
      client_total_cents: clientTotalCents,
      is_paid: null,
    });
  }

  const { CLOVER_ECOMM_PRIVATE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (!CLOVER_ECOMM_PRIVATE_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return paymentRequired(res, {
      reason: "MISSING_ENV",
      order_id: orderId || null,
      computed_total_cents: null,
      client_total_cents: clientTotalCents,
      is_paid: null,
    });
  }

  const supabase = supabaseServerClient();

  try {
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(
        "id,payment_status,total_cents,subtotal_cents,processing_fee_cents,delivery_fee_cents,discount_cents,promo_code,order_code,customer_name,customer_phone,fulfillment_type,delivery_address,clover_payment_id,clover_order_id",
      )
      .eq("id", orderId)
      .single();

    if (orderError) {
      const message = String(orderError.message || "");
      if (orderError.code === "PGRST116" || message.toLowerCase().includes("0 rows")) {
        return paymentRequired(res, {
          reason: "ORDER_NOT_FOUND",
          order_id: orderId || null,
          computed_total_cents: null,
          client_total_cents: clientTotalCents,
          is_paid: null,
        });
      }
      throw orderError;
    }

    if (!order) {
      return paymentRequired(res, {
        reason: "ORDER_NOT_FOUND",
        order_id: orderId || null,
        computed_total_cents: null,
        client_total_cents: clientTotalCents,
        is_paid: null,
      });
    }

    const computedTotalCents =
      toNumber(order.subtotal_cents) +
      toNumber(order.processing_fee_cents) +
      toNumber(order.delivery_fee_cents) -
      toNumber(order.discount_cents);
    const orderTotalCents = toNumber(order.total_cents);
    const isPaid = order.payment_status === "paid";

    if (
      computedTotalCents !== orderTotalCents ||
      (clientTotalCents !== null && clientTotalCents !== orderTotalCents)
    ) {
      return paymentRequired(res, {
        reason: "INVALID_TOTAL",
        order_id: order.id || null,
        computed_total_cents: computedTotalCents,
        client_total_cents: clientTotalCents,
        is_paid: isPaid,
      });
    }

    if (order.payment_status === "paid") {
      return paymentRequired(res, {
        reason: "ORDER_ALREADY_PAID",
        order_id: order.id || null,
        computed_total_cents: computedTotalCents,
        client_total_cents: clientTotalCents,
        is_paid: true,
      });
    }

    const { data: items, error: itemsError } = await supabase
      .from("order_items")
      .select("item_name,unit_price_cents,qty,line_total_cents")
      .eq("order_id", order.id)
      .order("id", { ascending: true });

    console.error("[payment] itemsPayload (raw items)", items);

    if (itemsError) throw itemsError;

    const cloverLineItems = (items || [])
      .map((it) => ({
        name: String(it.item_name || "").trim(),
        price: Number(it.unit_price_cents),
        quantity: Number(it.qty),
      }))
      .filter(
        (it) =>
          it.name &&
          Number.isFinite(it.price) &&
          it.price > 0 &&
          Number.isFinite(it.quantity) &&
          it.quantity > 0,
      );

    if (cloverLineItems.length === 0) {
      return paymentRequired(res, {
        reason: "NO_VALID_ITEMS_FOR_CLOVER",
        order_id: order.id || null,
        computed_total_cents: computedTotalCents,
        client_total_cents: clientTotalCents,
        is_paid: false,
      });
    }

    const noteText = buildOrderNote(order);
    const orderDescription = `Decoo Online Order ${order.order_code || ""}`.trim();
    const orderCreatePayload = {
      currency: "USD",
      note: noteText,
      line_items: cloverLineItems,
      description: orderDescription,
    };

    const { resp: createOrderResp, data: createOrderData } = await fetchJson(
      `${CLOVER_ECOMM_BASE}/v1/orders`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CLOVER_ECOMM_PRIVATE_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": createIdempotencyKey(),
        },
        body: JSON.stringify(orderCreatePayload),
      },
    );

    if (!createOrderResp.ok) {
      throw new Error(
        `Clover order create failed (status=${createOrderResp.status}): ${responseSnippet(createOrderData)}`,
      );
    }

    const cloverOrderId =
      createOrderData?.id || createOrderData?.order?.id || createOrderData?.data?.id || null;
    if (!cloverOrderId) {
      throw new Error("Clover eCommerce order id missing.");
    }

    const payPayload = {
      amount: Number(order.total_cents),
      currency: "USD",
      source: sourceId,
      description: orderDescription,
    };

    const { resp: payResp, data: payData } = await fetchJson(
      `${CLOVER_ECOMM_BASE}/v1/orders/${cloverOrderId}/pay`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CLOVER_ECOMM_PRIVATE_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": createIdempotencyKey(),
        },
        body: JSON.stringify(payPayload),
      },
    );

    if (!payResp.ok) {
      const payReason = payData?.error?.code || `CLOVER_${payResp.status}`;

      return paymentRequired(res, {
        reason: payReason,
        order_id: order.id || null,
        computed_total_cents: computedTotalCents,
        client_total_cents: clientTotalCents,
        is_paid: false,
      });
    }

    const paymentId = payData?.id || payData?.payment?.id || payData?.charge?.id || null;

    const { error: paidError } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        paid_at: new Date().toISOString(),
        clover_payment_id: paymentId,
        clover_order_id: cloverOrderId,
      })
      .eq("id", order.id);

    if (paidError) {
      console.error("[payment] Failed to update order payment status", {
        order_id: order.id,
        error: paidError,
      });
      throw paidError;
    }

    // Increment promo usage only after successful payment status update.
    if (order.promo_code && toNumber(order.discount_cents) > 0) {
      const code = String(order.promo_code).trim().toUpperCase();
      await supabase.rpc("promo_codes_increment_used_count", { p_code: code }).catch(() => null);
    }

    return ok(res, {
      ok: true,
      order_id: order.id,
      order_code: order.order_code,
      payment_status: "paid",
      clover_payment_id: paymentId,
      clover_order_id: cloverOrderId,
      warnings: [],
    });
  } catch (err) {
    console.error("[payment] Charge flow failed", err);
    return fail(res, 500, "PAYMENT_FAILED", "Could not process payment. Please try again.");
  }
}
