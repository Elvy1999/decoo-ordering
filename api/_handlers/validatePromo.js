import {
  ok,
  fail,
  methodNotAllowed,
  supabaseServerClient,
  toCents,
  isNonEmptyString,
} from "./shared.js";

const normalizeCode = (code) => String(code || "").trim().toUpperCase();

const computeDiscountCents = ({ discount_type, discount_value, subtotal_cents, max_discount_cents }) => {
  const subtotal = toCents(subtotal_cents);
  const val = Math.max(0, toCents(discount_value));
  if (subtotal <= 0) return 0;

  let discount = 0;

  if (discount_type === "flat") {
    discount = val;
  } else if (discount_type === "percent") {
    const pct = Math.max(0, Math.min(100, Math.floor(val)));
    discount = Math.floor((subtotal * pct) / 100);
  }

  const cap = max_discount_cents === null || max_discount_cents === undefined ? null : toCents(max_discount_cents);
  if (cap !== null) discount = Math.min(discount, cap);

  return Math.max(0, Math.min(discount, subtotal));
};

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!req.body || typeof req.body !== "object") return fail(res, 400, "VALIDATION_ERROR", "Invalid request body.");

  const code = normalizeCode(req.body.code);
  const subtotalCents = toCents(req.body.subtotal_cents);

  if (!isNonEmptyString(code)) return fail(res, 400, "VALIDATION_ERROR", "Promo code is required.");
  if (subtotalCents <= 0) return fail(res, 400, "VALIDATION_ERROR", "Subtotal is required.");

  const supabase = supabaseServerClient();

  try {
    const { data: promo, error } = await supabase
      .from("promo_codes")
      .select(
        "code,discount_type,discount_value,min_order_cents,max_discount_cents,active,starts_at,expires_at,usage_limit,used_count",
      )
      .eq("code", code)
      .single();

    if (error || !promo) {
      return ok(res, { ok: true, valid: false, code, discount_cents: 0, message: "Code not found." });
    }

    if (!promo.active) {
      return ok(res, { ok: true, valid: false, code, discount_cents: 0, message: "Code is inactive." });
    }

    const now = Date.now();
    if (promo.starts_at && Date.parse(promo.starts_at) > now) {
      return ok(res, { ok: true, valid: false, code, discount_cents: 0, message: "Code not active yet." });
    }
    if (promo.expires_at && Date.parse(promo.expires_at) <= now) {
      return ok(res, { ok: true, valid: false, code, discount_cents: 0, message: "Code has expired." });
    }

    const minOrder = toCents(promo.min_order_cents);
    if (subtotalCents < minOrder) {
      return ok(res, {
        ok: true,
        valid: false,
        code,
        discount_cents: 0,
        message: `Minimum order is $${(minOrder / 100).toFixed(2)}.`,
      });
    }

    if (promo.usage_limit !== null && promo.usage_limit !== undefined) {
      const limit = Math.max(0, Math.floor(Number(promo.usage_limit)));
      const used = Math.max(0, Math.floor(Number(promo.used_count || 0)));
      if (used >= limit) {
        return ok(res, { ok: true, valid: false, code, discount_cents: 0, message: "Code usage limit reached." });
      }
    }

    const discountCents = computeDiscountCents({
      discount_type: promo.discount_type,
      discount_value: promo.discount_value,
      subtotal_cents: subtotalCents,
      max_discount_cents: promo.max_discount_cents,
    });

    if (discountCents <= 0) {
      return ok(res, { ok: true, valid: false, code, discount_cents: 0, message: "Code not applicable." });
    }

    return ok(res, {
      ok: true,
      valid: true,
      code: promo.code,
      discount_type: promo.discount_type,
      discount_cents: discountCents,
      message: "Promo applied.",
    });
  } catch (err) {
    console.error("[promo] validate failed:", err);
    return fail(res, 500, "PROMO_VALIDATE_FAILED", "Could not validate promo code.");
  }
}
