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
const CLOVER_POS_BASE = "https://api.clover.com";

const formatCents = (value) => {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents)) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
};

const shortError = (err) => {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err.slice(0, 180);
  if (err.message) return String(err.message).slice(0, 180);
  if (err.error) return String(err.error).slice(0, 180);
  return "Unknown error";
};

const buildOrderNote = (order) => {
  const type = String(order.fulfillment_type || "").toUpperCase() || "-";
  return [
    `ONLINE ORDER: ${order.order_code || "-"}`,
    `Type: ${type}`,
    `Name: ${order.customer_name || "-"}`,
    `Phone: ${order.customer_phone || "-"}`,
    `Address: ${order.delivery_address || "-"}`,
    "---",
    `Subtotal: ${formatCents(order.subtotal_cents)}`,
    `Processing fee: ${formatCents(order.processing_fee_cents)}`,
    `Delivery fee: ${formatCents(order.delivery_fee_cents)}`,
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

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!req.body || typeof req.body !== "object") {
    return fail(res, 400, "VALIDATION_ERROR", "Invalid request body.");
  }

  const rawOrderId = req.body?.order_id ?? req.body?.orderId ?? "";
  const orderId = String(rawOrderId).trim();

  const rawSourceId = req.body?.source_id ?? req.body?.sourceId ?? "";
  const sourceId = String(rawSourceId).trim();

  if (!isNonEmptyString(orderId)) {
    return fail(res, 400, "VALIDATION_ERROR", "order_id is required.");
  }
  if (!isNonEmptyString(sourceId) || !sourceId.startsWith("clv_")) {
    return fail(res, 400, "VALIDATION_ERROR", "source_id is invalid.");
  }

  const {
    CLOVER_ECOMM_PRIVATE_KEY,
    CLOVER_REST_API_TOKEN,
    CLOVER_MERCHANT_ID,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  } = process.env;

  if (
    !CLOVER_ECOMM_PRIVATE_KEY ||
    !CLOVER_REST_API_TOKEN ||
    !CLOVER_MERCHANT_ID ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return fail(res, 500, "SERVER_CONFIG_ERROR", "Server configuration error.");
  }

  const supabase = supabaseServerClient();

  try {
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(
        "id,payment_status,total_cents,subtotal_cents,processing_fee_cents,delivery_fee_cents,order_code,customer_name,customer_phone,fulfillment_type,delivery_address,clover_payment_id,clover_order_id",
      )
      .eq("id", orderId)
      .single();

    if (orderError) {
      const message = String(orderError.message || "");
      if (orderError.code === "PGRST116" || message.toLowerCase().includes("0 rows")) {
        return fail(res, 404, "ORDER_NOT_FOUND", "Order not found.");
      }
      throw orderError;
    }

    if (!order) {
      return fail(res, 404, "ORDER_NOT_FOUND", "Order not found.");
    }

    if (order.payment_status === "paid") {
      return ok(res, {
        ok: true,
        already_paid: true,
        order_id: order.id,
        order_code: order.order_code,
        clover_payment_id: order.clover_payment_id || null,
        clover_order_id: order.clover_order_id || null,
        status: "paid",
      });
    }

    const chargePayload = {
      amount: toNumber(order.total_cents),
      currency: "USD",
      source: sourceId,
      description: `Decoo Online Order ${order.order_code || ""}`.trim(),
    };

    const { resp: chargeResp, data: chargeData } = await fetchJson(`${CLOVER_ECOMM_BASE}/v1/charges`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOVER_ECOMM_PRIVATE_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": createIdempotencyKey(),
      },
      body: JSON.stringify(chargePayload),
    });

    if (!chargeResp.ok) {
      console.error("[payment] Clover charge failed", {
        status: chargeResp.status,
        order_id: order.id,
        order_code: order.order_code,
        error: chargeData?.error || chargeData?.message || null,
      });
      return json(res, 402, {
        ok: false,
        code: "PAYMENT_FAILED",
        error: "Payment was declined. Please try another card.",
      });
    }

    const chargeId =
      chargeData?.id || chargeData?.charge?.id || chargeData?.payment?.id || chargeData?.data?.id || null;

    const { error: paidError } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        paid_at: new Date().toISOString(),
        clover_payment_id: chargeId,
      })
      .eq("id", order.id);

    if (paidError) {
      console.error("[payment] Failed to update order payment status", {
        order_id: order.id,
        error: paidError,
      });
    }

    const { data: items, error: itemsError } = await supabase
      .from("order_items")
      .select("item_name,unit_price_cents,qty,line_total_cents")
      .eq("order_id", order.id)
      .order("id", { ascending: true });

    if (itemsError) throw itemsError;

    const noteText = buildOrderNote(order);
    let cloverOrderId = null;
    let noteAttached = true;

    try {
      const { resp: orderResp, data: orderData } = await fetchJson(
        `${CLOVER_POS_BASE}/v3/merchants/${CLOVER_MERCHANT_ID}/orders`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${CLOVER_REST_API_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            state: "Open",
            currency: "USD",
            total: toNumber(order.total_cents),
            note: noteText,
          }),
        },
      );

      if (!orderResp.ok) {
        noteAttached = false;
        const { resp: retryResp, data: retryData } = await fetchJson(
          `${CLOVER_POS_BASE}/v3/merchants/${CLOVER_MERCHANT_ID}/orders`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${CLOVER_REST_API_TOKEN}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              state: "Open",
              currency: "USD",
              total: toNumber(order.total_cents),
            }),
          },
        );
        if (!retryResp.ok) {
          throw new Error(`Clover order create failed: ${shortError(retryData)}`);
        }
        cloverOrderId = retryData?.id || retryData?.order?.id || null;
      } else {
        cloverOrderId = orderData?.id || orderData?.order?.id || null;
      }

      if (!cloverOrderId) {
        throw new Error("Clover order id missing.");
      }

      for (const item of items || []) {
        const itemPayload = {
          name: item.item_name,
          price: toNumber(item.unit_price_cents),
          unitQty: toNumber(item.qty),
        };

        const { resp: itemResp, data: itemData } = await fetchJson(
          `${CLOVER_POS_BASE}/v3/merchants/${CLOVER_MERCHANT_ID}/orders/${cloverOrderId}/line_items`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${CLOVER_REST_API_TOKEN}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(itemPayload),
          },
        );

        if (!itemResp.ok) {
          throw new Error(`Clover line item failed: ${shortError(itemData)}`);
        }
      }

      if (!noteAttached) {
        const { resp: noteResp, data: noteData } = await fetchJson(
          `${CLOVER_POS_BASE}/v3/merchants/${CLOVER_MERCHANT_ID}/orders/${cloverOrderId}/line_items`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${CLOVER_REST_API_TOKEN}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              name: "ORDER INFO",
              price: 0,
              unitQty: 1,
              note: noteText,
            }),
          },
        );
        if (!noteResp.ok) {
          console.error("[payment] Failed to attach order note", {
            order_id: order.id,
            clover_order_id: cloverOrderId,
            error: noteData?.error || noteData?.message || null,
          });
        }
      }

      const { error: posUpdateError } = await supabase
        .from("orders")
        .update({
          clover_order_id: cloverOrderId,
          pos_status: "ok",
        })
        .eq("id", order.id);

      if (posUpdateError) {
        console.error("[payment] Failed to update Clover order id", {
          order_id: order.id,
          error: posUpdateError,
        });
      }
    } catch (posErr) {
      const msg = shortError(posErr);
      console.error("[payment] Clover POS order failed", { order_id: order.id, error: msg });

      await supabase
        .from("orders")
        .update({
          pos_status: "failed",
          pos_error: msg,
          clover_order_id: cloverOrderId || null,
        })
        .eq("id", order.id);

      return ok(res, {
        ok: true,
        order_id: order.id,
        order_code: order.order_code,
        payment_status: "paid",
        clover_payment_id: chargeId,
        clover_order_id: cloverOrderId,
        warnings: ["pos_failed"],
      });
    }

    const warnings = [];

    const { resp: printResp, data: printData } = await fetchJson(
      `${CLOVER_POS_BASE}/v3/merchants/${CLOVER_MERCHANT_ID}/print_event`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CLOVER_REST_API_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          orderRef: { id: cloverOrderId },
        }),
      },
    );

    if (!printResp.ok) {
      const msg = shortError(printData);
      warnings.push("print_failed");
      console.error("[payment] Print event failed", { order_id: order.id, error: msg });
      await supabase
        .from("orders")
        .update({
          print_status: "failed",
          print_error: msg,
        })
        .eq("id", order.id);
    } else {
      await supabase
        .from("orders")
        .update({
          print_status: "ok",
        })
        .eq("id", order.id);
    }

    return ok(res, {
      ok: true,
      order_id: order.id,
      order_code: order.order_code,
      payment_status: "paid",
      clover_payment_id: chargeId,
      clover_order_id: cloverOrderId,
      warnings,
    });
  } catch (err) {
    console.error("[payment] Charge flow failed", err);
    return fail(res, 500, "PAYMENT_FAILED", "Could not process payment. Please try again.");
  }
}
