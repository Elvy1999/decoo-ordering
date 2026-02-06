import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireAdmin } from "./auth.js";

const PROMO_SELECT =
  "id,code,discount_type,discount_value,min_order_cents,max_discount_cents,used_count,active,starts_at,first_order_only,note,created_at,updated_at";

const normalizeCode = (value) => String(value || "").trim().toUpperCase();
const asInteger = (value) => {
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
};

export async function handleAdminPromoCode(req, res) {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const body = req.body || {};
  if (!body || typeof body !== "object") {
    return fail(res, 400, "VALIDATION_ERROR", "Invalid request body.");
  }

  if (typeof body.code !== "string") {
    return fail(res, 400, "VALIDATION_ERROR", "code is required.");
  }

  const code = normalizeCode(body.code);
  if (!code) {
    return fail(res, 400, "VALIDATION_ERROR", "code is required.");
  }

  const discountType = typeof body.discount_type === "string" ? body.discount_type.trim().toLowerCase() : "";
  if (discountType !== "flat" && discountType !== "percent") {
    return fail(res, 400, "VALIDATION_ERROR", "discount_type must be flat or percent.");
  }

  const discountValue = asInteger(body.discount_value);
  if (discountValue === null || discountValue <= 0) {
    return fail(res, 400, "VALIDATION_ERROR", "discount_value must be an integer > 0.");
  }

  const minOrderInput = body.min_order_cents ?? 0;
  const minOrderCents = asInteger(minOrderInput);
  if (minOrderCents === null || minOrderCents < 0) {
    return fail(res, 400, "VALIDATION_ERROR", "min_order_cents must be an integer >= 0.");
  }

  if (typeof body.active !== "boolean") {
    return fail(res, 400, "VALIDATION_ERROR", "active must be a boolean.");
  }

  const payload = {
    code,
    discount_type: discountType,
    discount_value: discountValue,
    min_order_cents: minOrderCents,
    usage_limit: null,
    expires_at: null,
    active: body.active,
  };

  try {
    const supabase = supabaseServerClient();
    const { data, error } = await supabase
      .from("promo_codes")
      .upsert(payload, { onConflict: "code" })
      .select(PROMO_SELECT)
      .single();

    if (error) throw error;
    return ok(res, { ok: true, promo_code: data });
  } catch (err) {
    console.error("Failed to save promo code:", err);
    return fail(res, 500, "PROMO_CODE_SAVE_FAILED", "Could not save promo code.");
  }
}

export default handleAdminPromoCode;
