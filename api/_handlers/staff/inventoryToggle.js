import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
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
  if (!id) return fail(res, 400, "VALIDATION_ERROR", "Menu item id is required.");

  const body = getBodyObject(req);
  if (typeof body.in_stock !== "boolean") {
    return fail(res, 400, "VALIDATION_ERROR", "in_stock must be a boolean.");
  }

  try {
    const supabase = supabaseServerClient();
    const { data, error } = await supabase
      .from("menu_items")
      .update({ in_stock: body.in_stock })
      .eq("id", id)
      .select("id,name,category,in_stock,price_cents,badge,is_active,sort_order")
      .single();

    if (error) throw error;

    return ok(res, data);
  } catch (err) {
    console.error("Failed to toggle staff inventory:", err);
    return fail(res, 500, "STAFF_INVENTORY_TOGGLE_FAILED", "Could not update inventory item.");
  }
}
