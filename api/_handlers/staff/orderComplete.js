import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { sendOrderReadySms } from "../twilio.js";
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

const normalizeStatus = (value) => String(value || "").trim().toLowerCase();

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

    const { data: existingOrder, error: existingOrderError } = await supabase
      .from("orders")
      .select("id,status")
      .eq("id", id)
      .maybeSingle();
    if (existingOrderError) throw existingOrderError;
    if (!existingOrder) return fail(res, 404, "NOT_FOUND", "Order not found.");

    const previousStatus = normalizeStatus(existingOrder.status);

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

    const updatedStatus = normalizeStatus(data?.status || nextStatus);
    const transitionedToCompleted = previousStatus !== "completed" && updatedStatus === "completed";
    if (transitionedToCompleted) {
      // Best-effort async send; completion response should not depend on SMS provider.
      void sendOrderReadySms(supabase, id);
    }

    return ok(res, data);
  } catch (err) {
    console.error("Failed to update staff order completion:", err);
    return fail(res, 500, "STAFF_ORDER_UPDATE_FAILED", "Could not update order completion.");
  }
}
