import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireStaff } from "./auth.js";
import { queueOrderTransitionSms } from "../orderSmsTransitions.js";

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

  const nextStatus = body.completed ? "completed" : "new";

  try {
    const supabase = supabaseServerClient();

    const { data: existingOrder, error: existingOrderError } = await supabase
      .from("orders")
      .select("id,status,payment_status,confirmation_sms_sent,ready_sms_sent")
      .eq("id", id)
      .maybeSingle();
    if (existingOrderError) throw existingOrderError;
    if (!existingOrder) return fail(res, 404, "NOT_FOUND", "Order not found.");

    const { data, error } = await supabase
      .from("orders")
      .update({
        status: nextStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id,status,payment_status,confirmation_sms_sent,ready_sms_sent")
      .single();

    if (error) throw error;

    queueOrderTransitionSms({ supabase, oldOrder: existingOrder, newOrder: data });

    return ok(res, data);
  } catch (err) {
    console.error("Failed to update staff order completion:", err);
    return fail(res, 500, "STAFF_ORDER_UPDATE_FAILED", "Could not update order completion.");
  }
}
