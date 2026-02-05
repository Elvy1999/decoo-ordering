import {
  ok,
  fail,
  methodNotAllowed,
  supabaseServerClient,
  fetchSettings,
  isValidPhone,
  toCents,
  geocodeAddressMapbox,
  haversineMiles,
  NAME_MIN_LEN,
  NAME_MAX_LEN,
  ADDRESS_MIN_LEN,
  ADDRESS_MAX_LEN,
  MAX_ITEM_QTY,
  MAX_TOTAL_QTY,
  MAX_UNIQUE_ITEMS,
} from "./shared.js";

function validateOrderPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { error: "Invalid order payload." };
  }

  const name = typeof payload.customer_name === "string" ? payload.customer_name.trim() : "";
  const phone = typeof payload.customer_phone === "string" ? payload.customer_phone.trim() : "";

  if (!name || !phone) return { error: "Name and phone are required." };

  if (name.length < NAME_MIN_LEN || name.length > NAME_MAX_LEN) {
    return { error: `Name must be between ${NAME_MIN_LEN} and ${NAME_MAX_LEN} characters.` };
  }

  if (!isValidPhone(phone)) {
    return {
      error:
        "Phone number must contain at least 10 digits and may include only numbers, spaces, parentheses, plus, or hyphens.",
    };
  }

  if (payload.fulfillment_type !== "pickup" && payload.fulfillment_type !== "delivery") {
    return { error: "Order type must be pickup or delivery." };
  }

  if (payload.fulfillment_type === "delivery") {
    const address = typeof payload.delivery_address === "string" ? payload.delivery_address.trim() : "";
    if (!address) return { error: "Delivery address is required for delivery orders." };
    if (address.length < ADDRESS_MIN_LEN || address.length > ADDRESS_MAX_LEN) {
      return {
        error: `Delivery address must be between ${ADDRESS_MIN_LEN} and ${ADDRESS_MAX_LEN} characters.`,
      };
    }
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) return { error: "Cart is empty." };

  const normalizedItems = new Map();
  let totalQty = 0;

  for (const item of payload.items) {
    if (!item || typeof item !== "object")
      return { error: "Each item must include a valid id and quantity." };

    const id = Number(item.id);
    if (!Number.isFinite(id)) return { error: "Each item must include a valid id and quantity." };

    const qtyValue = Number(item.qty);
    if (!Number.isFinite(qtyValue)) return { error: "Each item must include a valid id and quantity." };

    const qty = Math.floor(qtyValue);
    if (qty < 1 || qtyValue > MAX_ITEM_QTY) {
      return { error: `Each item quantity must be between 1 and ${MAX_ITEM_QTY}.` };
    }

    const nextQty = (normalizedItems.get(id) || 0) + qty;
    if (nextQty > MAX_ITEM_QTY) {
      return { error: `Each item quantity must be between 1 and ${MAX_ITEM_QTY}.` };
    }

    normalizedItems.set(id, nextQty);
    totalQty += qty;

    if (normalizedItems.size > MAX_UNIQUE_ITEMS) {
      return { error: `Cart cannot contain more than ${MAX_UNIQUE_ITEMS} unique items.` };
    }
    if (totalQty > MAX_TOTAL_QTY) {
      return { error: `Cart cannot contain more than ${MAX_TOTAL_QTY} total items.` };
    }
  }

  return { error: "", normalizedItems };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const validation = validateOrderPayload(req.body);
  if (validation.error) {
    return fail(res, 400, "VALIDATION_ERROR", validation.error);
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return fail(res, 500, "SERVER_CONFIG_ERROR", "Server configuration error.");
  }

  const { customer_name, customer_phone, fulfillment_type, delivery_address } = req.body;
  const normalizedItems = validation.normalizedItems;
  const itemIds = Array.from(normalizedItems.keys());

  try {
    const supabase = supabaseServerClient();
    const settings = await fetchSettings(supabase);

    if (!settings?.ordering_enabled) {
      return fail(res, 400, "ORDERING_CLOSED", "Ordering is currently closed.");
    }
    if (fulfillment_type === "delivery" && !settings?.delivery_enabled) {
      return fail(res, 400, "DELIVERY_DISABLED", "Delivery is unavailable right now.");
    }

    const { data: menuRows, error: menuError } = await supabase
      .from("menu_items")
      .select("id,name,price_cents,is_active,in_stock")
      .in("id", itemIds);

    if (menuError) throw menuError;

    const menuById = new Map();
    (menuRows || []).forEach((row) => menuById.set(Number(row.id), row));

    if (menuById.size !== itemIds.length) {
      return fail(res, 400, "ITEM_UNAVAILABLE", "One or more items are unavailable.");
    }

    const orderItems = [];
    let subtotalCents = 0;

    for (const [id, qty] of normalizedItems.entries()) {
      const menuItem = menuById.get(id);
      if (!menuItem || !menuItem.is_active || !menuItem.in_stock) {
        return fail(res, 400, "ITEM_UNAVAILABLE", "One or more items are unavailable.");
      }

      const priceCents = toCents(menuItem.price_cents);
      const lineTotal = priceCents * qty;
      subtotalCents += lineTotal;

      orderItems.push({
        item_name: menuItem.name,
        unit_price_cents: priceCents,
        qty,
        line_total_cents: lineTotal,
      });
    }

    let deliveryDistanceMiles = null;

    if (fulfillment_type === "delivery") {
      const minTotal = toCents(settings.delivery_min_total_cents);
      if (subtotalCents < minTotal) {
        return fail(
          res,
          400,
          "DELIVERY_MIN_NOT_MET",
          `Delivery requires a minimum of $${(minTotal / 100).toFixed(2)}.`,
        );
      }

      const radiusMiles = Number(settings?.delivery_radius_miles);
      if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) {
        return fail(res, 500, "RADIUS_NOT_CONFIGURED", "Delivery radius is not configured.");
      }

      const RESTAURANT_LAT = Number(process.env.RESTAURANT_LAT);
      const RESTAURANT_LNG = Number(process.env.RESTAURANT_LNG);
      if (!Number.isFinite(RESTAURANT_LAT) || !Number.isFinite(RESTAURANT_LNG)) {
        return fail(res, 500, "RESTAURANT_LOCATION_MISSING", "Restaurant location is not configured.");
      }

      const geo = await geocodeAddressMapbox(delivery_address);
      if (!geo) {
        return fail(
          res,
          400,
          "ADDRESS_NOT_FOUND",
          "Could not verify that delivery address. Please include city and ZIP code.",
        );
      }

      const distanceMiles = haversineMiles(RESTAURANT_LAT, RESTAURANT_LNG, geo.lat, geo.lng);
      deliveryDistanceMiles = distanceMiles;

      if (distanceMiles > radiusMiles) {
        return fail(res, 400, "OUTSIDE_RADIUS", `Delivery is available within ${radiusMiles} miles.`);
      }
    }

    const processingFeeCents = subtotalCents > 0 ? toCents(settings.processing_fee_cents) : 0;
    const deliveryFeeCents = fulfillment_type === "delivery" ? toCents(settings.delivery_fee_cents) : 0;
    const totalCents = subtotalCents + processingFeeCents + deliveryFeeCents;

    const orderCode = `DCO-${Math.floor(10000 + Math.random() * 90000)}`;

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        customer_name,
        customer_phone,
        fulfillment_type,
        delivery_address: fulfillment_type === "delivery" ? delivery_address : null,
        subtotal_cents: subtotalCents,
        processing_fee_cents: processingFeeCents,
        delivery_fee_cents: deliveryFeeCents,
        total_cents: totalCents,
        order_code: orderCode,
        payment_status: "unpaid",
      })
      .select("id,order_code,total_cents")
      .single();

    if (orderError) throw orderError;

    const orderItemRows = orderItems.map((item) => ({
      order_id: order.id,
      item_name: item.item_name,
      unit_price_cents: item.unit_price_cents,
      qty: item.qty,
      line_total_cents: item.line_total_cents,
    }));

    const { error: itemsError } = await supabase.from("order_items").insert(orderItemRows);
    if (itemsError) throw itemsError;

    // server logs (shows up in Vercel function logs)
    const finalOrderCode = order.order_code || orderCode;
    const finalTotalCents = order.total_cents ?? totalCents;

    const orderLog = {
      order_code: finalOrderCode,
      fulfillment_type,
      subtotal_cents: subtotalCents,
      total_cents: finalTotalCents,
    };
    if (fulfillment_type === "delivery" && Number.isFinite(deliveryDistanceMiles)) {
      orderLog.distance_miles = Number(deliveryDistanceMiles.toFixed(2));
    }
    console.log("[order]", orderLog);

    return ok(res, {
      ok: true,
      order_id: order.id,
      order_code: finalOrderCode,
      total_cents: finalTotalCents,
    });
  } catch (err) {
    console.error("Order processing failed:", err);
    return fail(res, 500, "ORDER_FAILED", "Could not place order. Please try again.");
  }
}
