import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireAdmin } from "./auth.js";

const isInteger = (value) => Number.isInteger(Number(value));

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "PATCH") return methodNotAllowed(res, ["PATCH"]);

  const body = req.body || {};
  const id = Number(body.id);

  if (!Number.isFinite(id)) {
    return fail(res, 400, "VALIDATION_ERROR", "Menu item id is required.");
  }

  const update = {};

  if (Object.prototype.hasOwnProperty.call(body, "is_active")) {
    if (typeof body.is_active !== "boolean") {
      return fail(res, 400, "VALIDATION_ERROR", "is_active must be a boolean.");
    }
    update.is_active = body.is_active;
  }

  if (Object.prototype.hasOwnProperty.call(body, "in_stock")) {
    if (typeof body.in_stock !== "boolean") {
      return fail(res, 400, "VALIDATION_ERROR", "in_stock must be a boolean.");
    }
    update.in_stock = body.in_stock;
  }

  if (Object.prototype.hasOwnProperty.call(body, "price_cents")) {
    if (!isInteger(body.price_cents) || Number(body.price_cents) < 0) {
      return fail(res, 400, "VALIDATION_ERROR", "price_cents must be an integer >= 0.");
    }
    update.price_cents = Number(body.price_cents);
  }

  if (Object.prototype.hasOwnProperty.call(body, "sort_order")) {
    if (!isInteger(body.sort_order)) {
      return fail(res, 400, "VALIDATION_ERROR", "sort_order must be an integer.");
    }
    update.sort_order = Number(body.sort_order);
  }

  if (Object.prototype.hasOwnProperty.call(body, "badge")) {
    if (body.badge === null) {
      update.badge = null;
    } else if (typeof body.badge !== "string") {
      return fail(res, 400, "VALIDATION_ERROR", "badge must be a string.");
    } else if (body.badge.length > 40) {
      return fail(res, 400, "VALIDATION_ERROR", "badge must be 40 characters or less.");
    } else {
      update.badge = body.badge.trim();
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return fail(res, 400, "VALIDATION_ERROR", "name must be a non-empty string.");
    }
    update.name = body.name.trim();
  }

  if (Object.prototype.hasOwnProperty.call(body, "category")) {
    if (typeof body.category !== "string" || body.category.trim().length === 0) {
      return fail(res, 400, "VALIDATION_ERROR", "category must be a non-empty string.");
    }
    update.category = body.category.trim();
  }

  if (Object.keys(update).length === 0) {
    return fail(res, 400, "VALIDATION_ERROR", "No valid fields provided.");
  }

  try {
    const supabase = supabaseServerClient();
    const { data, error } = await supabase
      .from("menu_items")
      .update(update)
      .eq("id", id)
      .select("id,name,category,price_cents,badge,in_stock,is_active,sort_order")
      .single();

    if (error) throw error;
    return ok(res, data);
  } catch (err) {
    console.error("Failed to update menu item:", err);
    return fail(res, 500, "MENU_ITEM_UPDATE_FAILED", "Could not update menu item.");
  }
}
