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
const CLOVER_POS_BASE = String(process.env.CLOVER_REST_BASE_URL || "https://api.clover.com").trim();

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

  const {
    CLOVER_ECOMM_PRIVATE_KEY,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  } = process.env;
  const REST_TOKEN = String(process.env.CLOVER_REST_API_TOKEN || "").trim();
  const MID = String(process.env.CLOVER_MERCHANT_ID || "").trim();

  if (
    !CLOVER_ECOMM_PRIVATE_KEY ||
    !REST_TOKEN ||
    !MID ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
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

    if (computedTotalCents !== orderTotalCents || (clientTotalCents !== null && clientTotalCents !== orderTotalCents)) {
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
      const chargeReason =
        chargeData?.error?.code ||
        chargeData?.error?.type ||
        chargeData?.code ||
        `CLOVER_${chargeResp.status}`;

      return paymentRequired(res, {
        reason: chargeReason,
        order_id: order.id || null,
        computed_total_cents: computedTotalCents,
        client_total_cents: clientTotalCents,
        is_paid: false,
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

    // Increment promo usage only after successful payment status update.
    if (!paidError && order.promo_code && toNumber(order.discount_cents) > 0) {
      const code = String(order.promo_code).trim().toUpperCase();
      await supabase.rpc("promo_codes_increment_used_count", { p_code: code }).catch(() => null);
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
      const { resp: authResp, data: authData } = await fetchJson(`${CLOVER_POS_BASE}/v3/merchants/${MID}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${REST_TOKEN}`,
          Accept: "application/json",
        },
      });

      console.error("[payment] Clover POS auth test", {
        pos_base: CLOVER_POS_BASE,
        mid_last4: MID.slice(-4),
        token_len: REST_TOKEN.length,
        status: authResp.status,
        body: responseSnippet(authData, 300),
      });

      if (authResp.status === 401) {
        await supabase
          .from("orders")
          .update({
            pos_status: "failed",
            pos_error: "POS_AUTH_FAILED",
            clover_order_id: null,
          })
          .eq("id", order.id);

        return ok(res, {
          ok: true,
          order_id: order.id,
          order_code: order.order_code,
          payment_status: "paid",
          clover_payment_id: chargeId,
          clover_order_id: null,
          warnings: ["pos_failed"],
        });
      }

      const { resp: orderResp, data: orderData } = await fetchJson(
        `${CLOVER_POS_BASE}/v3/merchants/${MID}/orders`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${REST_TOKEN}`,
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
          `${CLOVER_POS_BASE}/v3/merchants/${MID}/orders`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${REST_TOKEN}`,
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
          throw new Error(
            `Clover order create failed (status=${retryResp.status}): ${responseSnippet(retryData, 300)}`,
          );
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
          `${CLOVER_POS_BASE}/v3/merchants/${MID}/orders/${cloverOrderId}/line_items`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${REST_TOKEN}`,
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
          `${CLOVER_POS_BASE}/v3/merchants/${MID}/orders/${cloverOrderId}/line_items`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${REST_TOKEN}`,
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
      `${CLOVER_POS_BASE}/v3/merchants/${MID}/print_event`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REST_TOKEN}`,
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
