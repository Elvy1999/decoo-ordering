import Twilio from "twilio";
import { normalizePhoneToE164, toCents } from "./shared.js";

const MAX_SMS_BODY_CHARS = 1600;
const SMS_ITEM_NAME_MAX_CHARS = 72;
const SMS_MORE_ITEMS_LINE = "(+ more items)";

const ORDER_SELECT_WITH_SMS_FLAGS = "id,customer_phone,total_cents,confirmation_sms_sent,ready_sms_sent";
const ORDER_SELECT_WITH_LEGACY_SMS_FLAGS = "id,customer_phone,total_cents,placed_sms_sent,ready_sms_sent";
const ORDER_SELECT_FALLBACK = "id,customer_phone,total_cents";

const SMS_FLAG_MODE_NONE = "none";
const SMS_FLAG_MODE_MODERN = "modern";
const SMS_FLAG_MODE_LEGACY = "legacy";

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

function buildConfirmationSmsBody(orderId, totalCents, groupedItems) {
  const header = `Order #${orderId} confirmed!`;
  const totalLine = `Total: $${toMoneyString(totalCents)}`;
  const footer = "Thank you for ordering Decoo Restaurant!";

  const itemLines = groupedItems.map((row) => {
    const name = clipText(row.item_name, SMS_ITEM_NAME_MAX_CHARS) || "Item";
    const qty = Math.max(1, Math.trunc(Number(row.qty) || 0));
    return `${name} * ${qty}`;
  });

  const renderMessage = (lines, includeMoreItemsLine = false) => {
    const combinedItemLines = includeMoreItemsLine ? [...lines, SMS_MORE_ITEMS_LINE] : lines;
    const itemsBlock = combinedItemLines.join("\n");
    return [header, "", itemsBlock, "", totalLine, "", footer].join("\n");
  };

  const full = renderMessage(itemLines, false);
  if (full.length <= MAX_SMS_BODY_CHARS) return full;

  // Keep top lines and append a short indicator when the message is too long.
  const keptLines = [...itemLines];
  while (keptLines.length > 0) {
    const candidate = renderMessage(keptLines, true);
    if (candidate.length <= MAX_SMS_BODY_CHARS) return candidate;
    keptLines.pop();
  }

  const smallest = renderMessage([], true);
  return smallest.length <= MAX_SMS_BODY_CHARS ? smallest : clipText(smallest, MAX_SMS_BODY_CHARS);
}

function buildReadySmsBody(orderId) {
  return [`Order #${orderId} is ready for pickup!`, "", "Thank you for choosing Decoo Restaurant."].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadOrderForSms(supabase, orderId) {
  const primary = await supabase.from("orders").select(ORDER_SELECT_WITH_SMS_FLAGS).eq("id", orderId).maybeSingle();
  if (!primary.error) {
    return { order: primary.data || null, flagMode: SMS_FLAG_MODE_MODERN };
  }

  if (isMissingColumnError(primary.error, "confirmation_sms_sent") || isMissingColumnError(primary.error, "ready_sms_sent")) {
    const legacy = await supabase
      .from("orders")
      .select(ORDER_SELECT_WITH_LEGACY_SMS_FLAGS)
      .eq("id", orderId)
      .maybeSingle();

    if (!legacy.error) {
      if (legacy.data) {
        console.warn("[sms] confirmation_sms_sent column is missing; using legacy placed_sms_sent column.");
      }
      return {
        order: legacy.data
          ? {
              ...legacy.data,
              confirmation_sms_sent: legacy.data.placed_sms_sent === true,
            }
          : null,
        flagMode: SMS_FLAG_MODE_LEGACY,
      };
    }

    if (!isMissingColumnError(legacy.error, "placed_sms_sent") && !isMissingColumnError(legacy.error, "ready_sms_sent")) {
      throw legacy.error;
    }

    const fallback = await supabase.from("orders").select(ORDER_SELECT_FALLBACK).eq("id", orderId).maybeSingle();
    if (fallback.error) throw fallback.error;

    if (fallback.data) {
      console.warn("[sms] orders SMS flag columns are missing; run SMS migration for full idempotency.");
    }

    return {
      order: fallback.data
        ? { ...fallback.data, confirmation_sms_sent: false, ready_sms_sent: false }
        : null,
      flagMode: SMS_FLAG_MODE_NONE,
    };
  }

  throw primary.error;
}

function hasMissingColumnError(error, columns) {
  for (const col of columns) {
    if (isMissingColumnError(error, col)) return true;
  }
  return false;
}

async function updateSmsFlag(supabase, orderId, payload, flagColumn) {
  const { error } = await supabase.from("orders").update(payload).eq("id", orderId).eq(flagColumn, false);
  return { ok: !error, error };
}

async function markSmsSent(supabase, orderId, type, flagMode) {
  if (flagMode === SMS_FLAG_MODE_NONE) return { ok: false, skipped: "missing-sms-columns" };

  const nowIso = new Date().toISOString();

  if (type === "confirmation") {
    const attempts = [];
    if (flagMode === SMS_FLAG_MODE_MODERN) {
      attempts.push({
        flagColumn: "confirmation_sms_sent",
        payload: { confirmation_sms_sent: true, confirmation_sms_sent_at: nowIso },
        columns: ["confirmation_sms_sent", "confirmation_sms_sent_at"],
      });
    }

    attempts.push({
      flagColumn: "placed_sms_sent",
      payload: { placed_sms_sent: true, placed_sms_sent_at: nowIso },
      columns: ["placed_sms_sent", "placed_sms_sent_at"],
    });

    for (const attempt of attempts) {
      const result = await updateSmsFlag(supabase, orderId, attempt.payload, attempt.flagColumn);
      if (result.ok) return { ok: true };
      if (hasMissingColumnError(result.error, [attempt.flagColumn, ...attempt.columns])) continue;
      throw result.error;
    }

    console.warn("[sms] orders confirmation SMS columns are missing; run SMS migration for idempotency.");
    return { ok: false, skipped: "missing-sms-columns" };
  }

  const readyResult = await updateSmsFlag(
    supabase,
    orderId,
    { ready_sms_sent: true, ready_sms_sent_at: nowIso },
    "ready_sms_sent",
  );
  if (readyResult.ok) return { ok: true };

  if (hasMissingColumnError(readyResult.error, ["ready_sms_sent", "ready_sms_sent_at"])) {
    console.warn("[sms] orders ready SMS columns are missing; run SMS migration for idempotency.");
    return { ok: false, skipped: "missing-sms-columns" };
  }

  throw readyResult.error;
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

export async function sendOrderConfirmationSms(supabase, orderId) {
  if (!orderId || !supabase) return { ok: false, skipped: "invalid-input" };
  try {
    const { order, flagMode } = await loadOrderForSms(supabase, orderId);
    const hasSmsFlags = flagMode !== SMS_FLAG_MODE_NONE;
    if (!order) return { ok: false, skipped: "order-not-found" };
    if (hasSmsFlags && order.confirmation_sms_sent === true) return { ok: true, skipped: "already-sent" };

    const normalizedPhone = normalizePhoneToE164(order.customer_phone);
    if (!normalizedPhone) {
      console.warn("[sms] skipped confirmation SMS due to missing or invalid customer_phone", { order_id: orderId });
      return { ok: false, skipped: "invalid-phone" };
    }

    const { data: orderItems, error: orderItemsError } = await supabase
      .from("order_items")
      .select("id,item_name,qty")
      .eq("order_id", orderId)
      .order("id", { ascending: true });
    if (orderItemsError) throw orderItemsError;

    const groupedItems = aggregateOrderItems(orderItems);
    const body = buildConfirmationSmsBody(order.id, order.total_cents, groupedItems);
    const sent = await sendSmsWithRetry(normalizedPhone, body, 3);

    const markResult = await markSmsSent(supabase, order.id, "confirmation", flagMode);
    if (!markResult.ok) {
      console.warn("[sms] confirmation SMS sent but flag update skipped", {
        order_id: order.id,
        skipped: markResult.skipped || null,
      });
      return { ok: false, error: "SMS_FLAG_UPDATE_FAILED", sid: sent?.sid || null };
    }

    console.log("[sms] confirmation message sent", {
      order_id: order.id,
      to: normalizedPhone,
      provider_message_id: sent?.sid || null,
    });

    return { ok: true, sid: sent?.sid || null };
  } catch (err) {
    console.error("[sms] failed to send order confirmation SMS", {
      order_id: orderId,
      error: err?.message || err,
    });
    return { ok: false, error: err?.message || "SMS_SEND_FAILED" };
  }
}

export async function sendOrderReadySms(supabase, orderId) {
  if (!orderId || !supabase) return { ok: false, skipped: "invalid-input" };
  try {
    const { order, flagMode } = await loadOrderForSms(supabase, orderId);
    const hasSmsFlags = flagMode !== SMS_FLAG_MODE_NONE;
    if (!order) return { ok: false, skipped: "order-not-found" };
    if (hasSmsFlags && order.ready_sms_sent === true) return { ok: true, skipped: "already-sent" };

    const normalizedPhone = normalizePhoneToE164(order.customer_phone);
    if (!normalizedPhone) {
      console.warn("[sms] skipped ready SMS due to missing or invalid customer_phone", { order_id: orderId });
      return { ok: false, skipped: "invalid-phone" };
    }

    const body = buildReadySmsBody(order.id);
    const sent = await sendSmsWithRetry(normalizedPhone, body, 3);
    const markResult = await markSmsSent(supabase, order.id, "ready", flagMode);
    if (!markResult.ok) {
      console.warn("[sms] ready SMS sent but flag update skipped", {
        order_id: order.id,
        skipped: markResult.skipped || null,
      });
      return { ok: false, error: "SMS_FLAG_UPDATE_FAILED", sid: sent?.sid || null };
    }

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
export const sendOrderPlacedSms = sendOrderConfirmationSms;

// Backward-compatible export name used in existing handlers.
export const sendOrderCompletedSms = sendOrderReadySms;
