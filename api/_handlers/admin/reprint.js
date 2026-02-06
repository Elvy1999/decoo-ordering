import { ok, fail, json, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireAdmin } from "./auth.js";

const DEFAULT_CLOVER_REST_BASE_URL = "https://api.clover.com";

const parseId = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const shortError = (err) => {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err.slice(0, 180);
  if (typeof err?.message === "string" && err.message.trim().length) {
    return err.message.slice(0, 180);
  }
  if (typeof err?.error === "string" && err.error.trim().length) {
    return err.error.slice(0, 180);
  }
  if (typeof err?.error?.message === "string" && err.error.message.trim().length) {
    return err.error.message.slice(0, 180);
  }
  return "Unknown error";
};

const toBaseUrl = (value) => {
  const raw = String(value || DEFAULT_CLOVER_REST_BASE_URL).trim();
  return raw.replace(/\/+$/, "");
};

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const id = parseId(req.query?.id);
  if (!id) {
    return fail(res, 400, "VALIDATION_ERROR", "Order id is required.");
  }

  try {
    const supabase = supabaseServerClient();
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id,clover_order_id")
      .eq("id", id)
      .single();

    if (orderError) throw orderError;
    if (!order) return fail(res, 404, "NOT_FOUND", "Order not found.");

    if (!order.clover_order_id) {
      return json(res, 400, { error: { message: "No Clover order id to print." } });
    }

    const { CLOVER_REST_API_TOKEN, CLOVER_MERCHANT_ID } = process.env;
    const CLOVER_REST_BASE_URL = toBaseUrl(process.env.CLOVER_REST_BASE_URL);
    if (!CLOVER_REST_API_TOKEN || !CLOVER_MERCHANT_ID) {
      return fail(res, 500, "CLOVER_ENV_MISSING", "Clover credentials are not configured.");
    }

    const printUrl = `${CLOVER_REST_BASE_URL}/v3/merchants/${CLOVER_MERCHANT_ID}/print_event`;
    const printResp = await fetch(printUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOVER_REST_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        orderRef: { id: order.clover_order_id },
      }),
    });

    const printData = await printResp.json().catch(() => null);

    if (!printResp.ok) {
      const msg = shortError(printData) || `Print failed (${printResp.status})`;
      const { error: printUpdateError } = await supabase
        .from("orders")
        .update({
          print_status: "failed",
          print_error: msg,
        })
        .eq("id", id);
      if (printUpdateError) throw printUpdateError;
      return fail(res, 502, "REPRINT_FAILED", msg);
    }

    const { error: printUpdateError } = await supabase
      .from("orders")
      .update({
        print_status: "ok",
        print_error: null,
      })
      .eq("id", id);
    if (printUpdateError) throw printUpdateError;

    return ok(res, { ok: true });
  } catch (err) {
    console.error("Failed to reprint order:", err);
    return fail(res, 500, "REPRINT_REQUEST_FAILED", "Could not request reprint.");
  }
}
