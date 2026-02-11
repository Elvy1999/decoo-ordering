import { ok, fail, methodNotAllowed, supabaseServerClient, fetchSettings, SETTINGS_ROW_ID } from "../shared.js";
import { requireAdmin } from "./auth.js";

const SETTINGS_FIELDS =
  "ordering_enabled,delivery_enabled,delivery_radius_miles,processing_fee_cents,delivery_fee_cents,delivery_min_total_cents,free_juice_enabled,free_juice_min_subtotal_cents,free_juice_item_id";

const isFiniteNumber = (value) => Number.isFinite(Number(value));
const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const isNaturalJuiceMenuItem = (menuItem) => {
  const category = normalizeText(menuItem?.category);
  const name = normalizeText(menuItem?.name);
  const looksJuice = category.includes("juice") || category.includes("jugo") || name.includes("juice") || name.includes("jugo");
  const looksSoda =
    category.includes("soda") ||
    name.includes("soda") ||
    name.includes("coke") ||
    name.includes("sprite") ||
    name.includes("pepsi");
  return looksJuice && !looksSoda;
};

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;

  if (req.method === "GET") {
    try {
      const supabase = supabaseServerClient();
      const settings = await fetchSettings(supabase);
      return ok(res, settings);
    } catch (err) {
      console.error("Failed to load admin settings:", err);
      return fail(res, 500, "SETTINGS_LOAD_FAILED", "Could not load settings.");
    }
  }

  if (req.method !== "PATCH") return methodNotAllowed(res, ["GET", "PATCH"]);

  const body = req.body || {};
  const update = {};

  if (Object.prototype.hasOwnProperty.call(body, "ordering_enabled")) {
    if (typeof body.ordering_enabled !== "boolean") {
      return fail(res, 400, "VALIDATION_ERROR", "ordering_enabled must be a boolean.");
    }
    update.ordering_enabled = body.ordering_enabled;
  }

  if (Object.prototype.hasOwnProperty.call(body, "delivery_enabled")) {
    if (typeof body.delivery_enabled !== "boolean") {
      return fail(res, 400, "VALIDATION_ERROR", "delivery_enabled must be a boolean.");
    }
    update.delivery_enabled = body.delivery_enabled;
  }

  const numberFields = [
    "delivery_radius_miles",
    "processing_fee_cents",
    "delivery_fee_cents",
    "delivery_min_total_cents",
    "free_juice_min_subtotal_cents",
  ];

  for (const field of numberFields) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    if (body[field] === "" || body[field] === null) {
      return fail(res, 400, "VALIDATION_ERROR", `${field} must be a non-negative number.`);
    }
    if (!isFiniteNumber(body[field])) {
      return fail(res, 400, "VALIDATION_ERROR", `${field} must be a non-negative number.`);
    }
    const value = Number(body[field]);
    if (value < 0) {
      return fail(res, 400, "VALIDATION_ERROR", `${field} must be a non-negative number.`);
    }
    update[field] = value;
  }

  if (Object.prototype.hasOwnProperty.call(body, "free_juice_enabled")) {
    if (typeof body.free_juice_enabled !== "boolean") {
      return fail(res, 400, "VALIDATION_ERROR", "free_juice_enabled must be a boolean.");
    }
    update.free_juice_enabled = body.free_juice_enabled;
  }

  if (Object.prototype.hasOwnProperty.call(body, "free_juice_item_id")) {
    const rawValue = body.free_juice_item_id;
    if (rawValue === "" || rawValue === null) {
      update.free_juice_item_id = null;
    } else if (!isFiniteNumber(rawValue) || !Number.isInteger(Number(rawValue)) || Number(rawValue) <= 0) {
      return fail(res, 400, "VALIDATION_ERROR", "free_juice_item_id must be a positive integer or null.");
    } else {
      update.free_juice_item_id = Number(rawValue);
    }
  }

  if (Object.keys(update).length === 0) {
    return fail(res, 400, "VALIDATION_ERROR", "No valid fields provided.");
  }

  try {
    const supabase = supabaseServerClient();
    const current = await fetchSettings(supabase);
    const next = { ...current, ...update };

    if (next.delivery_enabled) {
      const radius = Number(next.delivery_radius_miles);
      if (!Number.isFinite(radius) || radius <= 0) {
        return fail(
          res,
          400,
          "VALIDATION_ERROR",
          "delivery_radius_miles must be greater than 0 when delivery is enabled.",
        );
      }
    }

    if (next.free_juice_enabled) {
      const minSubtotal = Number(next.free_juice_min_subtotal_cents);
      if (!Number.isFinite(minSubtotal) || minSubtotal <= 0) {
        return fail(
          res,
          400,
          "VALIDATION_ERROR",
          "free_juice_min_subtotal_cents must be greater than 0 when free juice promo is enabled.",
        );
      }

      const promoItemId = Number(next.free_juice_item_id);
      if (!Number.isInteger(promoItemId) || promoItemId <= 0) {
        return fail(
          res,
          400,
          "VALIDATION_ERROR",
          "free_juice_item_id is required when free juice promo is enabled.",
        );
      }

      const { data: promoItem, error: promoItemError } = await supabase
        .from("menu_items")
        .select("id,name,category")
        .eq("id", promoItemId)
        .maybeSingle();

      if (promoItemError) throw promoItemError;
      if (!promoItem) {
        return fail(res, 400, "VALIDATION_ERROR", "free_juice_item_id does not match a menu item.");
      }
      if (!isNaturalJuiceMenuItem(promoItem)) {
        return fail(
          res,
          400,
          "VALIDATION_ERROR",
          "free_juice_item_id must match a natural juice menu item when free juice promo is enabled.",
        );
      }
    }

    const { data, error } = await supabase
      .from("settings")
      .update(update)
      .eq("id", SETTINGS_ROW_ID)
      .select(SETTINGS_FIELDS)
      .single();

    if (error) throw error;
    return ok(res, data);
  } catch (err) {
    console.error("Failed to update admin settings:", err);
    return fail(res, 500, "SETTINGS_UPDATE_FAILED", "Could not update settings.");
  }
}
