const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

app.use(express.json({ limit: "200kb" }));

const publicPath = path.join(__dirname, "..", "public");
const indexPath = path.join(publicPath, "index.html");
app.use(express.static(publicPath));
app.get("/", (req, res) => res.sendFile(indexPath));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}

const supabase = createClient(supabaseUrl || "", supabaseKey || "");

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

const NAME_MIN_LEN = 1;
const NAME_MAX_LEN = 30;
const ADDRESS_MIN_LEN = 5;
const ADDRESS_MAX_LEN = 60;
const MAX_UNIQUE_ITEMS = 30;
const MAX_ITEM_QTY = 20;
const MAX_TOTAL_QTY = 50;
const FREE_JUICE_PROMO_TYPE = "FREE_JUICE";

const digitsOnly = (phone) => String(phone || "").replace(/\D/g, "");
const isValidPhone = (phone) => {
  if (!isNonEmptyString(phone)) return false;
  const trimmed = phone.trim();
  if (!/^[0-9\s()+-]+$/.test(trimmed)) return false;
  return digitsOnly(trimmed).length >= 10;
};

const toCents = (value) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.round(numberValue);
};

const normalizeCategory = (value) =>
  String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

const isJuicesCategoryMenuItem = (menuItem) => normalizeCategory(menuItem?.category) === "juices";

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const RESTAURANT_LAT = Number(process.env.RESTAURANT_LAT);
const RESTAURANT_LNG = Number(process.env.RESTAURANT_LNG);

const isFiniteNumber = (n) => Number.isFinite(Number(n));

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3958.8; // miles

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function geocodeAddressMapbox(address) {
  if (!MAPBOX_TOKEN) {
    throw new Error("MAPBOX_TOKEN missing");
  }
  const query = encodeURIComponent(address);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${MAPBOX_TOKEN}&limit=1`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Mapbox geocoding failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const feature = data?.features?.[0];
  const center = feature?.center; // [lng, lat]

  if (!Array.isArray(center) || center.length < 2) {
    return null; // no match
  }

  return {
    lng: Number(center[0]),
    lat: Number(center[1]),
    place_name: feature?.place_name || "",
  };
}

const fetchSettings = async () => {
  const { data, error } = await supabase
    .from("settings")
    .select(
      "ordering_enabled,delivery_enabled,delivery_radius_miles,processing_fee_cents,delivery_fee_cents,delivery_min_total_cents,free_juice_enabled,free_juice_min_subtotal_cents",
    )
    .eq("id", 1)
    .single();

  if (error) throw error;
  return data;
};

app.get("/api/settings", async (req, res) => {
  try {
    const settings = await fetchSettings();
    return res.json(settings);
  } catch (error) {
    console.error("Failed to load settings:", error);
    return res.status(500).json({ ok: false, error: "Could not load settings." });
  }
});

app.get("/api/health", async (req, res) => {
  const checks = {
    server: true,
    env: {
      SUPABASE_URL: Boolean(supabaseUrl),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(supabaseKey),
    },
    restaurant_location: Number.isFinite(RESTAURANT_LAT) && Number.isFinite(RESTAURANT_LNG),
    supabase: false,
    settings_row: false,
    mapbox_token: true,
  };

  let settings = null;

  try {
    settings = await fetchSettings();
    checks.settings_row = Boolean(settings);
  } catch (error) {
    console.warn("[health] settings check failed.");
  }

  try {
    const { error } = await supabase.from("menu_items").select("id").limit(1);
    if (!error) {
      checks.supabase = true;
    }
  } catch (error) {
    console.warn("[health] supabase check failed.");
  }

  const deliveryEnabled = settings?.delivery_enabled === true;
  if (deliveryEnabled) {
    checks.mapbox_token = Boolean(MAPBOX_TOKEN);
  }

  const envOk = checks.env.SUPABASE_URL && checks.env.SUPABASE_SERVICE_ROLE_KEY;
  const ok =
    checks.server &&
    envOk &&
    checks.restaurant_location &&
    checks.supabase &&
    checks.settings_row &&
    checks.mapbox_token;

  return res.json({ ok, checks });
});

app.get("/api/menu", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("menu_items")
      .select("id,name,category,price_cents,badge,in_stock,is_active,sort_order")
      .eq("is_active", true)
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true });

    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    console.error("Failed to load menu:", error);
    return res.status(500).json({ ok: false, error: "Could not load menu." });
  }
});

app.post("/api/validate-delivery", async (req, res) => {
  try {
    const address = (req.body?.address || "").trim();
    if (!address) {
      return res.status(400).json({ ok: false, error: "Address is required." });
    }

    const settings = await fetchSettings();
    if (!settings?.delivery_enabled) {
      return res.status(400).json({ ok: false, error: "Delivery is unavailable right now." });
    }

    const radiusMiles = Number(settings?.delivery_radius_miles);
    if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) {
      return res.status(500).json({ ok: false, error: "Delivery radius is not configured." });
    }

    if (!Number.isFinite(RESTAURANT_LAT) || !Number.isFinite(RESTAURANT_LNG)) {
      return res.status(500).json({ ok: false, error: "Restaurant location is not configured." });
    }

    const geo = await geocodeAddressMapbox(address);
    if (!geo) {
      return res.status(400).json({
        ok: false,
        error: "Could not verify that address. Please include city and ZIP code.",
      });
    }

    const distanceMiles = haversineMiles(RESTAURANT_LAT, RESTAURANT_LNG, geo.lat, geo.lng);
    const withinRadius = distanceMiles <= radiusMiles;

    return res.json({
      ok: true,
      withinRadius,
      radiusMiles,
      distanceMiles: Number(distanceMiles.toFixed(2)),
      normalizedAddress: geo.place_name || "",
    });
  } catch (err) {
    console.error("validate-delivery failed:", err);
    return res.status(500).json({ ok: false, error: "Could not validate delivery address." });
  }
});

const validateOrderPayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    return { error: "Invalid order payload." };
  }

  const name = typeof payload.customer_name === "string" ? payload.customer_name.trim() : "";
  const phone = typeof payload.customer_phone === "string" ? payload.customer_phone.trim() : "";

  if (!name || !phone) {
    return { error: "Name and phone are required." };
  }
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
    if (!address) {
      return { error: "Delivery address is required for delivery orders." };
    }
    if (address.length < ADDRESS_MIN_LEN || address.length > ADDRESS_MAX_LEN) {
      return {
        error: `Delivery address must be between ${ADDRESS_MIN_LEN} and ${ADDRESS_MAX_LEN} characters.`,
      };
    }
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return { error: "Cart is empty." };
  }

  const normalizedItems = new Map();
  let clientPromoFreeItem = null;
  let promoFreeItemCount = 0;
  let totalQty = 0;

  for (const item of payload.items) {
    if (!item || typeof item !== "object") {
      return { error: "Each item must include a valid id and quantity." };
    }

    const id = Number(item.id);
    if (!Number.isFinite(id)) {
      return { error: "Each item must include a valid id and quantity." };
    }

    const promoTypeRaw =
      typeof item.promoType === "string"
        ? item.promoType
        : typeof item.promo_type === "string"
          ? item.promo_type
          : "";
    const promoType = promoTypeRaw.trim().toUpperCase();
    const isPromoFreeItem =
      item.isPromoFreeItem === true || item.is_promo_free_item === true || promoType === FREE_JUICE_PROMO_TYPE;

    if (isPromoFreeItem) {
      if (promoType && promoType !== FREE_JUICE_PROMO_TYPE) {
        return { error: "Unsupported promo item type." };
      }
      promoFreeItemCount += 1;
      if (promoFreeItemCount > 1) {
        return { error: "Only one free juice promo item is allowed per order." };
      }
      const promoQtyRaw =
        item.qty ?? item.quantity ?? item.qtyValue ?? item.quantityValue ?? item.count ?? item.item_qty ?? 1;
      const promoQty = Number(promoQtyRaw);
      if (!Number.isFinite(promoQty) || Math.floor(promoQty) !== 1) {
        return { error: "Free juice promo item quantity must be exactly 1." };
      }
      if (!clientPromoFreeItem) {
        clientPromoFreeItem = {
          id,
          qty: 1,
          isPromoFreeItem: true,
          promoType: FREE_JUICE_PROMO_TYPE,
        };
      }
      continue;
    }

    const qtyValue = Number(item.qty);
    if (!Number.isFinite(qtyValue)) {
      return { error: "Each item must include a valid id and quantity." };
    }
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

  if (normalizedItems.size === 0) {
    return { error: "Cart is empty." };
  }

  return { error: "", normalizedItems, clientPromoFreeItem };
};

app.post("/api/orders", async (req, res) => {
  const validation = validateOrderPayload(req.body);
  if (validation.error) {
    return res.status(400).json({ ok: false, error: validation.error });
  }

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ ok: false, error: "Server configuration error." });
  }

  const { customer_name, customer_phone, fulfillment_type, delivery_address } = req.body;
  const normalizedItems = validation.normalizedItems;
  const clientPromoFreeItem = validation.clientPromoFreeItem;

  const itemIds = Array.from(normalizedItems.keys());

  try {
    let deliveryDistanceMiles = null;
    const settings = await fetchSettings();
    if (!settings?.ordering_enabled) {
      return res.status(400).json({ ok: false, error: "Ordering is currently closed." });
    }
    if (fulfillment_type === "delivery" && !settings?.delivery_enabled) {
      return res.status(400).json({ ok: false, error: "Delivery is unavailable right now." });
    }

    const { data: menuRows, error: menuError } = await supabase
      .from("menu_items")
      .select("id,name,category,price_cents,is_active,in_stock")
      .in("id", itemIds);

    if (menuError) throw menuError;

    const menuById = new Map();
    (menuRows || []).forEach((row) => {
      menuById.set(Number(row.id), row);
    });

    if (menuById.size !== itemIds.length) {
      return res.status(400).json({ ok: false, error: "One or more items are unavailable." });
    }

    const orderItems = [];
    let subtotalCents = 0;

    for (const [id, qty] of normalizedItems.entries()) {
      const menuItem = menuById.get(id);
      if (!menuItem || !menuItem.is_active || !menuItem.in_stock) {
        return res.status(400).json({ ok: false, error: "One or more items are unavailable." });
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

    let freeJuicePromoApplied = false;
    const freeJuiceEnabled = settings?.free_juice_enabled === true;
    const freeJuiceMinSubtotalCents = Math.max(0, toCents(settings?.free_juice_min_subtotal_cents));
    const freeJuiceEligible = freeJuiceEnabled && freeJuiceMinSubtotalCents > 0 && subtotalCents >= freeJuiceMinSubtotalCents;

    if (freeJuiceEligible) {
      if (!clientPromoFreeItem) {
        return res.status(400).json({ ok: false, error: "Please select your free juice." });
      }

      const promoMenuItemId = Number(clientPromoFreeItem.id);
      if (!Number.isInteger(promoMenuItemId) || promoMenuItemId <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid free juice selection." });
      }

      let promoMenuItem = menuById.get(promoMenuItemId) || null;
      if (!promoMenuItem) {
        const { data: promoItemData, error: promoItemError } = await supabase
          .from("menu_items")
          .select("id,name,category,is_active,in_stock")
          .eq("id", promoMenuItemId)
          .maybeSingle();
        if (promoItemError) throw promoItemError;
        promoMenuItem = promoItemData || null;
      }

      if (!promoMenuItem || !promoMenuItem.is_active || !promoMenuItem.in_stock || !isJuicesCategoryMenuItem(promoMenuItem)) {
        return res.status(400).json({
          ok: false,
          error: "Selected free juice must be an active in-stock menu item in category 'Juices'.",
        });
      }

      orderItems.push({
        item_name: `${promoMenuItem.name} (Free Natural Juice Promo)`,
        unit_price_cents: 0,
        qty: 1,
        line_total_cents: 0,
      });
      freeJuicePromoApplied = true;
    } else if (clientPromoFreeItem) {
      console.log("[promo] dropped client free juice item", {
        sent_item_id: Number(clientPromoFreeItem.id) || null,
        subtotal_cents: subtotalCents,
        configured_min_subtotal_cents: freeJuiceMinSubtotalCents,
        promo_enabled: freeJuiceEnabled,
      });
    }

    if (fulfillment_type === "delivery") {
      const minTotal = toCents(settings.delivery_min_total_cents);
      if (subtotalCents < minTotal) {
        return res.status(400).json({
          ok: false,
          error: `Delivery requires a minimum of $${(minTotal / 100).toFixed(2)}.`,
        });
      }

      const radiusMiles = Number(settings?.delivery_radius_miles);

      if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) {
        return res.status(500).json({
          ok: false,
          error: "Delivery radius is not configured (settings.delivery_radius_miles).",
        });
      }

      if (!Number.isFinite(RESTAURANT_LAT) || !Number.isFinite(RESTAURANT_LNG)) {
        return res.status(500).json({ ok: false, error: "Restaurant location is not configured." });
      }

      const geo = await geocodeAddressMapbox(delivery_address);
      if (!geo) {
        return res.status(400).json({
          ok: false,
          error: "Could not verify that delivery address. Please include city and ZIP code.",
        });
      }

      const distanceMiles = haversineMiles(RESTAURANT_LAT, RESTAURANT_LNG, geo.lat, geo.lng);
      deliveryDistanceMiles = distanceMiles;

      console.log(
        "[delivery] address:",
        geo.place_name || delivery_address,
        "distance:",
        distanceMiles.toFixed(2),
        "radius:",
        radiusMiles,
      );

      if (distanceMiles > radiusMiles) {
        console.log("[delivery] rejecting: outside radius");
        return res.status(400).json({
          ok: false,
          error: `Delivery is available within ${radiusMiles} miles.`,
        });
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
    if (freeJuicePromoApplied) {
      orderLog.free_juice_promo = true;
    }

    console.log("[order]", orderLog);

    return res.json({
      ok: true,
      order_code: finalOrderCode,
      total_cents: finalTotalCents,
    });
  } catch (error) {
    console.error("Order processing failed:", error);
    return res.status(500).json({ ok: false, error: "Could not place order. Please try again." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
