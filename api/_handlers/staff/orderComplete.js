import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { sendOrderCompletedSms } from "../twilio.js";
import { requireStaff } from "./auth.js";

function parseId(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.trunc(num);
}

function getBodyObject(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      const parsed = JSON.parse(req.body);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req, res) {
  if (!requireStaff(req, res)) return;
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const id = parseId(req.query?.id);
  if (!id) return fail(res, 400, "VALIDATION_ERROR", "Order id is required.");

  const body = getBodyObject(req);
  if (typeof body.completed !== "boolean") {
    return fail(res, 400, "VALIDATION_ERROR", "completed must be a boolean.");
  }

  const nextStatus = body.completed ? "completed" : "paid";

  try {
    const supabase = supabaseServerClient();
    const { data, error } = await supabase
      .from("orders")
      .update({
        status: nextStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id,status")
      .single();

    if (error) throw error;

    // If the staff marked the order as completed, send an SMS notification to the customer (best-effort).
    if (nextStatus === "completed") {
      try {
        // fire-and-forget but await to log errors without blocking response on SMS failures
        await sendOrderCompletedSms(supabase, id);
      } catch (e) {
        console.error("Failed sending order completed SMS:", e);
      }
    }

    return ok(res, data);
  } catch (err) {
    console.error("Failed to update staff order completion:", err);
    return fail(res, 500, "STAFF_ORDER_UPDATE_FAILED", "Could not update order completion.");
  }
}
