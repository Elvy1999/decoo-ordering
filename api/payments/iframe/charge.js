import crypto from "crypto";
import {
  ok,
  fail,
  json,
  methodNotAllowed,
  supabaseServerClient,
  isNonEmptyString,
} from "../../_handlers/shared.js";
import { getValidCloverAccessToken, resolveCloverMerchantId } from "../../_lib/cloverAuth.js";
import { createCloverOrder, addOnlineOrderLineItem, printCloverOrder } from "../../_lib/cloverOrders.js";

const CLOVER_ECOMM_BASE = "https://scl.clover.com";

const responseSnippet = (value, max = 300) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, max);
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
};

const formatMoney = (cents) => `$${(toNumber(cents) / 100).toFixed(2)}`;

const formatOrderNote = ({
  orderId,
  type,
  name,
  phone,
  address,
  items,
  subtotalCents,
  discountCents,
  totalCents,
  promoCode,
}) => {
  const lines = [];
  lines.push(`Order #: ${orderId}`);
  lines.push(`Type: ${String(type || "-").toUpperCase()}`);
  lines.push(`Name: ${name || "-"}`);
  lines.push(`Phone: ${phone || "-"}`);
  if (address) lines.push(`Address: ${address}`);
  lines.push("");
  lines.push("Items:");
  for (const it of items || []) {
    const qty = Math.max(0, Math.trunc(toNumber(it.qty)));
    const itemName = String(it.item_name || "").trim() || "Item";
    const lineTotal =
      it.line_total_cents === null || it.line_total_cents === undefined
        ? toNumber(it.unit_price_cents) * qty
        : toNumber(it.line_total_cents);
    lines.push(`- ${qty}x ${itemName} (${formatMoney(lineTotal)})`);
  }
  lines.push("");
  lines.push(`Subtotal: ${formatMoney(subtotalCents)}`);
  if (toNumber(discountCents) > 0) {
    lines.push(
      `Discount: -${formatMoney(discountCents)}${promoCode ? ` (${String(promoCode).trim()})` : ""}`,
    );
  }
  lines.push(`Total: ${formatMoney(totalCents)}`);
  return lines.join("\n");
};

const shortError = (err) => {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err.slice(0, 180);
  if (typeof err?.message === "string" && err.message.trim().length) return err.message.slice(0, 180);
  if (typeof err?.error === "string" && err.error.trim().length) return err.error.slice(0, 180);
  if (typeof err?.details === "string" && err.details.trim().length) return err.details.slice(0, 180);
  if (typeof err?.error?.message === "string" && err.error.message.trim().length) {
    return err.error.message.slice(0, 180);
  }
  return "Unknown error";
};

const createIdempotencyKey = () => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const fetchJson = async (url, options = {}) => {
  const timeoutMs = typeof options.timeout === "number" ? options.timeout : 20000;
  const controller = new AbortController();
  const signal = controller.signal;

  const fetchOpts = { ...options, signal };

  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, fetchOpts);
    const text = await resp.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { resp, data };
  } catch (err) {
    // rethrow so callers can handle; keep err.name for AbortError
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
  console.log("[payment] handler START", { path: req.url || req.path || null, method: req.method || null });
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

  const customerEmail = String(process.env.CLOVER_FALLBACK_EMAIL || "orders@decoorestaurant.com").trim();

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

    const externalOrderNumber = `ORDER-${order.id}`;

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

    const cloverItems = [
      {
        name: "Online Order",
        amount: Math.trunc(Number(order.total_cents)),
        quantity: 1,
      },
    ];

    const itemsBreakdown = (items || [])
      .map((it) => `${Math.trunc(Number(it.qty))} x ${String(it.item_name).trim()}`)
      .join("\n");

    let noteText =
      `ORDER #: ${order.id}\n` +
      `====================\n` +
      `ITEMS:\n${itemsBreakdown}\n\n` +
      `TYPE: ${order.fulfillment_type}\n` +
      `Name: ${order.customer_name || "-"}\n` +
      `Phone: ${order.customer_phone || "-"}\n` +
      (order.delivery_address ? `Address: ${order.delivery_address}\n` : "") +
      `--------------------\n` +
      `TOTAL: $${(order.total_cents / 100).toFixed(2)}`;

    const orderCreatePayload = {
      currency: "USD",
      items: cloverItems,
      email: customerEmail,
      externalReferenceId: externalOrderNumber,
      referenceId: externalOrderNumber,
      title: externalOrderNumber,
      note: noteText,
    };

    console.log("[payment] ecomm order create -> calling Clover eComm", {
      flow: "ecomm",
      externalOrder: externalOrderNumber,
      amount_cents: order.total_cents,
    });

    let orderResp, orderData;
    try {
      ({ resp: orderResp, data: orderData } = await fetchJson(`${CLOVER_ECOMM_BASE}/v1/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CLOVER_ECOMM_PRIVATE_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": createIdempotencyKey(),
        },
        body: JSON.stringify(orderCreatePayload),
        timeout: 20000,
      }));
    } catch (err) {
      console.error("[payment] ecomm order create ERROR", {
        error: shortError(err),
        name: err?.name || null,
      });
      throw err;
    }

    console.log("[payment] ecomm order create response", {
      status: orderResp.status,
      snippet: responseSnippet(orderData),
    });
    if (!orderResp.ok) {
      console.error("[payment] ecomm order create failed", {
        status: orderResp.status,
        body: orderData,
      });
      throw new Error(
        `Clover order create failed (status=${orderResp.status}): ${responseSnippet(orderData)}`,
      );
    }

    const ecommOrderId = orderData?.id || orderData?.order?.id || orderData?.data?.id || null;
    if (!ecommOrderId) {
      throw new Error("Clover eComm order id missing");
    }

    const payPayload = {
      amount: Number(order.total_cents),
      currency: "USD",
      source: sourceId,
      description: `Online Order #${order.id}`,
    };

    console.log("[payment] ecomm pay -> calling Clover eComm pay", {
      orderId: ecommOrderId,
      amount: payPayload.amount,
    });
    let payResp, payData;
    try {
      ({ resp: payResp, data: payData } = await fetchJson(
        `${CLOVER_ECOMM_BASE}/v1/orders/${ecommOrderId}/pay`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${CLOVER_ECOMM_PRIVATE_KEY}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": createIdempotencyKey(),
          },
          body: JSON.stringify(payPayload),
          timeout: 20000,
        },
      ));
    } catch (err) {
      console.error("[payment] ecomm pay ERROR", { error: shortError(err), name: err?.name || null });
      return fail(res, 502, "PAYMENT_GATEWAY_ERROR", "Payment provider timeout or error.");
    }

    console.log("[payment] ecomm pay response", {
      status: payResp.status,
      snippet: responseSnippet(payData),
    });
    if (!payResp.ok) {
      console.error("[payment] ecomm pay failed", {
        status: payResp.status,
        body: payData,
      });
      const payReason = payData?.error?.code || payData?.error?.type || `CLOVER_${payResp.status}`;

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

    const warnings = [];
    let posOrderId = null;

    // POS sync (Clover REST) is non-blocking and best-effort: run asynchronously so it doesn't delay checkout response.
    (async () => {
      try {
        const merchantId = await resolveCloverMerchantId(process.env.CLOVER_MERCHANT_ID);
        const accessToken = await getValidCloverAccessToken(merchantId);
        const isDelivery = String(order.fulfillment_type || "").toLowerCase() === "delivery";
        const orderTypeId = isDelivery
          ? process.env.CLOVER_ORDER_TYPE_DELIVERY_ID
          : process.env.CLOVER_ORDER_TYPE_PICKUP_ID;

        const posNote = formatOrderNote({
          orderId: order.id,
          type: order.fulfillment_type,
          name: order.customer_name,
          phone: order.customer_phone,
          address: order.delivery_address,
          items,
          subtotalCents: order.subtotal_cents,
          discountCents: order.discount_cents,
          totalCents: order.total_cents,
          promoCode: order.promo_code,
        });

        console.log("[payment] POS sync -> creating POS order (async)", { merchantId, orderId: order.id });
        const posOrder = await createCloverOrder({
          merchantId,
          accessToken,
          title: `Online Order #${order.id}`,
          note: posNote,
          orderTypeId,
        });

        posOrderId = posOrder?.id || posOrder?.order?.id || null;
        if (!posOrderId) throw new Error("Clover POS order id missing");

        await addOnlineOrderLineItem({
          merchantId,
          accessToken,
          cloverOrderId: posOrderId,
          totalCents: order.total_cents,
          note: posNote,
        });

        try {
          await printCloverOrder({ merchantId, accessToken, cloverOrderId: posOrderId });
        } catch (printErr) {
          warnings.push("CLOVER_PRINT_FAILED");
          console.error("[payment] Clover print_event failed (async)", {
            order_id: order.id,
            error: shortError(printErr),
          });
        }

        await supabase
          .from("orders")
          .update({ clover_order_id: posOrderId, print_status: "ok" })
          .eq("id", order.id)
          .catch((e) =>
            console.error("[payment] POS save failed (async)", { order_id: order.id, error: shortError(e) }),
          );
      } catch (posErr) {
        console.error("[payment] Clover POS sync failed (async)", {
          order_id: order.id,
          error: shortError(posErr),
        });
        await supabase
          .from("orders")
          .update({ print_status: "failed", print_error: shortError(posErr) })
          .eq("id", order.id)
          .catch(() => null);
      }
    })();

    return ok(res, {
      ok: true,
      order_id: order.id,
      order_code: order.order_code,
      payment_status: "paid",
      clover_payment_id: paymentId,
      clover_order_id: posOrderId,
      warnings,
    });
  } catch (err) {
    console.error("[payment] Charge flow failed", err);
    return fail(res, 500, "PAYMENT_FAILED", "Could not process payment. Please try again.");
  }
}
