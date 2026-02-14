import Twilio from "twilio";
import { normalizePhoneToE164, toCents } from "./shared.js";

const MAX_SMS_BODY_CHARS = 1600;
const SMS_ITEM_NAME_MAX_CHARS = 72;
const SMS_MORE_ITEMS_LINE = "(+ more items)";

const ORDER_SELECT_WITH_SMS_FLAGS = "id,customer_phone,total_cents,placed_sms_sent,ready_sms_sent";
const ORDER_SELECT_FALLBACK = "id,customer_phone,total_cents";

function getTwilioClientOrThrow() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  return Twilio(String(sid).trim(), String(token).trim());
}

function getTwilioFromNumberOrThrow() {
  const from = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error("TWILIO_FROM_NUMBER must be set");
  return String(from).trim();
}

function isMissingColumnError(error, columnName) {
  const haystack = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return haystack.includes("column") && haystack.includes(String(columnName || "").toLowerCase());
}

function toMoneyString(cents) {
  return (toCents(cents) / 100).toFixed(2);
}

function clipText(text, maxChars) {
  const normalized = String(text || "").trim();
  if (!normalized) return "";
  if (!Number.isFinite(maxChars) || maxChars < 4 || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function aggregateOrderItems(orderItems) {
  const byName = new Map();
  for (const row of Array.isArray(orderItems) ? orderItems : []) {
    const rawName = String(row?.item_name || "").trim();
    const name = rawName || "Item";
    const key = name.toLowerCase();
    const qty = Math.max(0, Math.trunc(Number(row?.qty) || 0));
    if (qty <= 0) continue;

    if (!byName.has(key)) {
      byName.set(key, { item_name: name, qty });
      continue;
    }
    byName.get(key).qty += qty;
  }
  return Array.from(byName.values());
}

function buildPlacedSmsBody(orderId, totalCents, groupedItems) {
  const header = `Decoo Restaurant — Order #${orderId}`;
  const totalLine = `Total: $${toMoneyString(totalCents)}`;

  const itemLines = groupedItems.map((row) => {
    const name = clipText(row.item_name, SMS_ITEM_NAME_MAX_CHARS) || "Item";
    const qty = Math.max(1, Math.trunc(Number(row.qty) || 0));
    return `${name} * ${qty}`;
  });

  const full = [header, ...itemLines, totalLine].join("\n");
  if (full.length <= MAX_SMS_BODY_CHARS) return full;

  // Keep top lines and append a short indicator when the message is too long.
  const keptLines = [...itemLines];
  while (keptLines.length > 0) {
    const candidate = [header, ...keptLines, SMS_MORE_ITEMS_LINE, totalLine].join("\n");
    if (candidate.length <= MAX_SMS_BODY_CHARS) return candidate;
    keptLines.pop();
  }

  const smallest = [header, SMS_MORE_ITEMS_LINE, totalLine].join("\n");
  return smallest.length <= MAX_SMS_BODY_CHARS ? smallest : clipText(smallest, MAX_SMS_BODY_CHARS);
}

function buildReadySmsBody(orderId) {
  return `Decoo Restaurant: Your order #${orderId} is ready for pickup. See you soon!`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadOrderForSms(supabase, orderId) {
  const primary = await supabase.from("orders").select(ORDER_SELECT_WITH_SMS_FLAGS).eq("id", orderId).maybeSingle();
  if (!primary.error) {
    return { order: primary.data || null, hasSmsFlags: true };
  }

  if (isMissingColumnError(primary.error, "placed_sms_sent") || isMissingColumnError(primary.error, "ready_sms_sent")) {
    const fallback = await supabase.from("orders").select(ORDER_SELECT_FALLBACK).eq("id", orderId).maybeSingle();
    if (fallback.error) throw fallback.error;

    if (fallback.data) {
      console.warn("[sms] orders SMS flag columns are missing; run SMS migration for full idempotency.");
    }

    return {
      order: fallback.data
        ? { ...fallback.data, placed_sms_sent: false, ready_sms_sent: false }
        : null,
      hasSmsFlags: false,
    };
  }

  throw primary.error;
}

async function markSmsSent(supabase, orderId, type, hasSmsFlags) {
  if (!hasSmsFlags) return { ok: false, skipped: "missing-sms-columns" };

  const nowIso = new Date().toISOString();
  const isPlaced = type === "placed";
  const flagColumn = isPlaced ? "placed_sms_sent" : "ready_sms_sent";
  const payload = isPlaced
    ? { placed_sms_sent: true, placed_sms_sent_at: nowIso }
    : { ready_sms_sent: true, ready_sms_sent_at: nowIso };

  const { error } = await supabase.from("orders").update(payload).eq("id", orderId).eq(flagColumn, false);

  if (error) {
    if (
      isMissingColumnError(error, "placed_sms_sent") ||
      isMissingColumnError(error, "ready_sms_sent") ||
      isMissingColumnError(error, "placed_sms_sent_at") ||
      isMissingColumnError(error, "ready_sms_sent_at")
    ) {
      console.warn("[sms] orders SMS sent columns are missing; run SMS migration for idempotency.");
      return { ok: false, skipped: "missing-sms-columns" };
    }
    throw error;
  }

  return { ok: true };
}

async function sendSmsWithRetry(to, body, maxAttempts = 3) {
  const client = getTwilioClientOrThrow();
  const from = getTwilioFromNumberOrThrow();

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.messages.create({ from, to, body });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const backoffMs = 400 * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }
  throw lastError || new Error("Unknown SMS send failure");
}

export async function sendSms(to, body) {
  return sendSmsWithRetry(to, body, 1);
}

export async function sendOrderPlacedSms(supabase, orderId) {
  if (!orderId || !supabase) return { ok: false, skipped: "invalid-input" };
  try {
    const { order, hasSmsFlags } = await loadOrderForSms(supabase, orderId);
    if (!order) return { ok: false, skipped: "order-not-found" };
    if (hasSmsFlags && order.placed_sms_sent === true) return { ok: true, skipped: "already-sent" };

    const normalizedPhone = normalizePhoneToE164(order.customer_phone);
    if (!normalizedPhone) {
      console.warn("[sms] skipped placed SMS due to missing or invalid customer_phone", { order_id: orderId });
      return { ok: false, skipped: "invalid-phone" };
    }

    const { data: orderItems, error: orderItemsError } = await supabase
      .from("order_items")
      .select("id,item_name,qty")
      .eq("order_id", orderId)
      .order("id", { ascending: true });
    if (orderItemsError) throw orderItemsError;

    const groupedItems = aggregateOrderItems(orderItems);
    const body = buildPlacedSmsBody(order.id, order.total_cents, groupedItems);
    const sent = await sendSmsWithRetry(normalizedPhone, body, 3);

    await markSmsSent(supabase, order.id, "placed", hasSmsFlags);
    console.log("[sms] placed message sent", {
      order_id: order.id,
      to: normalizedPhone,
      provider_message_id: sent?.sid || null,
    });

    return { ok: true, sid: sent?.sid || null };
  } catch (err) {
    console.error("[sms] failed to send placed order SMS", {
      order_id: orderId,
      error: err?.message || err,
    });
    return { ok: false, error: err?.message || "SMS_SEND_FAILED" };
  }
}

export async function sendOrderReadySms(supabase, orderId) {
  if (!orderId || !supabase) return { ok: false, skipped: "invalid-input" };
  try {
    const { order, hasSmsFlags } = await loadOrderForSms(supabase, orderId);
    if (!order) return { ok: false, skipped: "order-not-found" };
    if (hasSmsFlags && order.ready_sms_sent === true) return { ok: true, skipped: "already-sent" };

    const normalizedPhone = normalizePhoneToE164(order.customer_phone);
    if (!normalizedPhone) {
      console.warn("[sms] skipped ready SMS due to missing or invalid customer_phone", { order_id: orderId });
      return { ok: false, skipped: "invalid-phone" };
    }

    const body = buildReadySmsBody(order.id);
    const sent = await sendSmsWithRetry(normalizedPhone, body, 3);
    await markSmsSent(supabase, order.id, "ready", hasSmsFlags);

    console.log("[sms] ready message sent", {
      order_id: order.id,
      to: normalizedPhone,
      provider_message_id: sent?.sid || null,
    });

    return { ok: true, sid: sent?.sid || null };
  } catch (err) {
    console.error("[sms] failed to send ready order SMS", {
      order_id: orderId,
      error: err?.message || err,
    });
    return { ok: false, error: err?.message || "SMS_SEND_FAILED" };
  }
}

// Backward-compatible export name used in existing handlers.
export const sendOrderCompletedSms = sendOrderReadySms;
