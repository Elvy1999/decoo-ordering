const CART_KEY = "decoo_cart";

let appSettings = null;
let itemById = {};
let menuItems = [];

const CATEGORY_MAP = {
  empanadas: "Empanadas",
  juices: "Juices",
  sodas: "Sodas",
  pinchos: "Grill",
  quipes: "Fried",
  alcapurrias: "Fried",
  sorullitos: "Fried",
  tresLeches: "Desserts",
};

const MENU_NAME_FILTER = {
  quipes: "Quipe",
  alcapurrias: "Alcapurria",
  sorullitos: "Sorullitos",
  tresLeches: "Tres Leches",
};

const normalizeCategory = (value) => String(value || "").trim().toLowerCase();

const formatMoney = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
};

const getErrorMessage = (data, fallback) => {
  if (!data) return fallback;
  if (typeof data.error === "string") return data.error;
  if (data.error && typeof data.error.message === "string") return data.error.message;
  if (typeof data.message === "string") return data.message;
  return fallback;
};

const normalizeSettings = (settings) => ({
  pickupEnabled: true,
  orderingEnabled: Boolean(settings?.ordering_enabled),
  deliveryEnabled: Boolean(settings?.delivery_enabled),
  deliveryRadiusMiles: Number(settings?.delivery_radius_miles || 0),
  processingFee: Number(settings?.processing_fee_cents || 0) / 100,
  deliveryFee: Number(settings?.delivery_fee_cents || 0) / 100,
  deliveryMinTotal: Number(settings?.delivery_min_total_cents || 0) / 100,
});

const normalizeMenuItem = (row) => ({
  id: String(row.id),
  name: row.name,
  category: row.category,
  price: Number(row.price_cents || 0) / 100,
  inStock: Boolean(row.in_stock),
  note: row.badge || "",
  sortOrder: row.sort_order,
});

const buildItemLookup = (items) =>
  items.reduce((acc, item) => {
    acc[item.id] = item;
    return acc;
  }, {});

const showAppError = (message) => {
  let errorEl = document.querySelector("[data-app-error]");
  if (!errorEl) {
    errorEl = document.createElement("div");
    errorEl.dataset.appError = "true";
    errorEl.className = "form-error app-error";
    errorEl.style.cssText =
      "display:block;margin:0 auto 16px;width:min(1100px, 92%);padding:12px 16px;border:1px solid #ffb3b3;border-radius:8px;color:#7a1b1b;font-weight:600;text-align:center;";
    const main = document.querySelector("main");
    (main || document.body).prepend(errorEl);
  }
  errorEl.textContent = message;
  errorEl.hidden = false;
};

const setOrderingClosedBanner = (isVisible) => {
  const banner = document.querySelector("[data-ordering-closed]");
  if (!banner) return;
  banner.hidden = !isVisible;
};

const setOrderingEnabledState = (enabled) => {
  const checkoutButton = document.querySelector("[data-open-checkout]");
  if (checkoutButton) checkoutButton.disabled = !enabled;
  const cartBar = document.querySelector("[data-cart-bar]");
  if (!enabled && cartBar) {
    cartBar.hidden = true;
    document.body.style.paddingBottom = "";
  }
};

const fetchSettingsAndMenu = async () => {
  try {
    const [settingsResponse, menuResponse] = await Promise.all([fetch("/api/settings"), fetch("/api/menu")]);
    if (!settingsResponse.ok || !menuResponse.ok) {
      throw new Error("Menu fetch failed");
    }
    const settingsData = await settingsResponse.json();
    const menuRows = await menuResponse.json();
    appSettings = normalizeSettings(settingsData);
    menuItems = Array.isArray(menuRows) ? menuRows.map(normalizeMenuItem) : [];
    itemById = buildItemLookup(menuItems);
    setOrderingEnabledState(appSettings.orderingEnabled);
    setOrderingClosedBanner(!appSettings.orderingEnabled);
  } catch (error) {
    appSettings = normalizeSettings({
      ordering_enabled: false,
      delivery_enabled: false,
      delivery_radius_miles: 0,
      processing_fee_cents: 0,
      delivery_fee_cents: 0,
      delivery_min_total_cents: 0,
    });
    menuItems = [];
    itemById = {};
    setOrderingEnabledState(false);
    setOrderingClosedBanner(false);
    showAppError("We couldn't load the menu right now. Please refresh or try again later.");
  }
};

// --- Cart math and persistence ---
const getCartItemCount = (cartState) => Object.values(cartState).reduce((sum, qty) => sum + qty, 0);

const getCartSubtotal = (cartState) =>
  Object.entries(cartState).reduce((sum, [id, qty]) => {
    const item = itemById[id];
    if (!item) return sum;
    return sum + item.price * qty;
  }, 0);

const calculateTotals = (cartState, orderType = "pickup", includeDeliveryFee = false, includeFees = false) => {
  const subtotal = getCartSubtotal(cartState);
  const processingFee = includeFees && subtotal > 0 ? appSettings?.processingFee || 0 : 0;
  const deliveryFee = orderType === "delivery" && includeDeliveryFee ? appSettings?.deliveryFee || 0 : 0;
  const tax = includeFees ? 0 : 0;
  const total = subtotal + processingFee + deliveryFee + tax;
  return { subtotal, processingFee, deliveryFee, tax, total };
};

const getDeliveryMinState = (cartState) => {
  const subtotal = getCartSubtotal(cartState);
  const min = appSettings?.deliveryMinTotal ?? 0;
  const isDelivery = checkoutState.orderType === "delivery";
  if (!isDelivery) return { show: false, subtotal, min, shortfall: 0, meetsMin: true };

  const shortfall = Math.max(0, min - subtotal);
  const meetsMin = shortfall <= 0.00001;
  return { show: true, subtotal, min, shortfall, meetsMin };
};

let showDeliveryMinWarning = false;

const renderDeliveryMinUI = (cartState) => {
  const state = getDeliveryMinState(cartState);

  const box = document.querySelector("[data-delivery-min]");
  const text = document.querySelector("[data-delivery-min-text]");
  const boxReview = document.querySelector("[data-delivery-min-review]");
  const textReview = document.querySelector("[data-delivery-min-review-text]");

  if (!state.show || !showDeliveryMinWarning) {
    if (box) box.hidden = true;
    if (boxReview) boxReview.hidden = true;
    return;
  }

  const message = state.meetsMin
    ? `Delivery minimum: ${formatMoney(state.min)} (before fees). Subtotal: ${formatMoney(state.subtotal)} ✅`
    : `Delivery minimum: ${formatMoney(state.min)} (before fees). Subtotal: ${formatMoney(state.subtotal)} — add ${formatMoney(state.shortfall)} more.`;

  if (box) box.hidden = false;
  if (text) text.textContent = message;

  if (boxReview) boxReview.hidden = false;
  if (textReview) textReview.textContent = message;
};

const loadCart = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(CART_KEY));
    if (!stored || typeof stored !== "object") return {};
    let invalidCount = 0;
    const next = Object.entries(stored).reduce((acc, [id, qty]) => {
      if (itemById[id] && Number.isFinite(qty) && qty > 0) {
        acc[id] = Math.floor(qty);
      } else {
        invalidCount += 1;
      }
      return acc;
    }, {});
    if (invalidCount > 0 && Object.keys(next).length === 0) {
      localStorage.removeItem(CART_KEY);
    }
    return next;
  } catch (error) {
    return {};
  }
};

const saveCart = (cartState) => {
  localStorage.setItem(CART_KEY, JSON.stringify(cartState));
};

// Removes sold-out or invalid items to keep the cart consistent with live menu data.
const sanitizeCartForStock = (cartState) =>
  Object.entries(cartState).reduce((acc, [id, qty]) => {
    const item = itemById[id];
    if (!item || item.inStock === false) return acc;
    if (Number.isFinite(qty) && qty > 0) {
      acc[id] = Math.floor(qty);
    }
    return acc;
  }, {});

const areCartsEqual = (a, b) => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
};

const clearCart = () => {
  cart = {};
  localStorage.removeItem(CART_KEY);
  syncUIAfterCartChange(cart);
};

// --- Cart mutations ---
const getQty = (cartState, id) => cartState[id] || 0;

const setQty = (cartState, id, qty) => {
  if (!itemById[id]) return;
  if (qty <= 0) {
    delete cartState[id];
    return;
  }
  cartState[id] = qty;
};

const increment = (cartState, id) => setQty(cartState, id, getQty(cartState, id) + 1);
const decrement = (cartState, id) => setQty(cartState, id, getQty(cartState, id) - 1);

// --- Rendering helpers ---
const getNoteClass = (note) =>
  note === "Prov, Motz, Ched" ? "menu-item__note menu-item__note--compact" : "menu-item__note";

const renderQtyControlMarkup = (qty, allowAdd) => {
  if (qty > 0) {
    return `
      <button class="qty-control__btn" type="button" data-action="decrease" aria-label="Decrease quantity">-</button>
      <span class="qty-control__qty">${qty}</span>
      <button class="qty-control__btn" type="button" data-action="increase" aria-label="Increase quantity">+</button>
    `;
  }
  if (!allowAdd) return "";
  return `<button class="qty-control__add" type="button" data-action="add">Add</button>`;
};

const renderMenuItemMarkup = (item, cartState) => {
  const noteMarkup = item.note ? `<small class="${getNoteClass(item.note)}">${item.note}</small>` : "";
  const qty = getQty(cartState, item.id);
  const soldOutBadge = item.inStock ? "" : '<span class="menu-item__soldout-badge">Sold out</span>';
  const qtyControlMarkup = item.inStock ? renderQtyControlMarkup(qty, true) : "";
  return `
    <li class="menu-item${item.inStock ? "" : " menu-item--soldout"}" data-id="${item.id}">
      <span class="menu-item__left">
        <span class="menu-item__name">${item.name}</span>
        ${noteMarkup}
      </span>
      <span class="menu-item__right">
        <span class="menu-item__price">${formatMoney(item.price)}</span>
        ${soldOutBadge}
        <span class="qty-control">${qtyControlMarkup}</span>
      </span>
    </li>
  `;
};

const renderMenuList = (listEl, items, cartState) => {
  listEl.innerHTML = items.map((item) => renderMenuItemMarkup(item, cartState)).join("");
};

const renderAllMenus = (cartState) => {
  document.querySelectorAll("[data-menu-list]").forEach((listEl) => {
    const key = listEl.dataset.menuList;
    const category = CATEGORY_MAP[key];
    if (!category) return;

    const categoryKey = normalizeCategory(category);

    let items = menuItems.filter((item) => normalizeCategory(item.category) === categoryKey);

    const requiredName = MENU_NAME_FILTER[key];
    if (requiredName) {
      const nameKey = normalizeCategory(requiredName);
      items = items.filter((item) => normalizeCategory(item.name) === nameKey);
    }

    const sortedItems = items
      .slice()
      .sort((a, b) => (Number(a.sortOrder || 0) || 0) - (Number(b.sortOrder || 0) || 0));

    renderMenuList(listEl, sortedItems, cartState);
  });
};

const renderCartList = (cartState) => {
  const listEl = document.querySelector("[data-cart-list]");
  if (!listEl) return;
  const entries = Object.entries(cartState);
  if (entries.length === 0) {
    listEl.innerHTML = '<li class="cart-empty">Your cart is empty</li>';
    return;
  }

  listEl.innerHTML = entries
    .map(([id, qty]) => {
      const item = itemById[id];
      if (!item) return "";
      return `
        <li class="cart-item" data-id="${id}">
          <span class="cart-item__name">${item.name}</span>
          <span class="cart-item__price">${formatMoney(item.price)}</span>
          <div class="qty-control">
            ${renderQtyControlMarkup(qty, false)}
          </div>
        </li>
      `;
    })
    .join("");
};

const updateMenuItemQtyById = (id, qty) => {
  const item = itemById[id];
  if (!item) return;
  if (item.inStock === false) {
    renderAllMenus(cart);
    return;
  }
  document.querySelectorAll(`.menu-item[data-id="${id}"]`).forEach((itemEl) => {
    const control = itemEl.querySelector(".qty-control");
    if (!control) return;
    control.innerHTML = renderQtyControlMarkup(qty, true);
  });
};

const updateCartTotals = (cartState) => {
  const totalsEl = document.querySelector("[data-cart-totals]");
  if (!totalsEl) return;
  const { subtotal, processingFee, deliveryFee, tax, total } = calculateTotals(
    cartState,
    checkoutState.orderType,
    false,
    false,
  );
  const subtotalEl = totalsEl.querySelector("[data-subtotal]");
  const feeEl = totalsEl.querySelector("[data-fee]");
  const deliveryEl = totalsEl.querySelector("[data-delivery-fee]");
  const taxEl = totalsEl.querySelector("[data-tax]");
  const totalEl = totalsEl.querySelector("[data-total]");
  if (subtotalEl) subtotalEl.textContent = formatMoney(subtotal);
  if (feeEl) feeEl.textContent = formatMoney(processingFee);
  if (deliveryEl) deliveryEl.textContent = formatMoney(deliveryFee);
  if (taxEl) taxEl.textContent = formatMoney(tax);
  if (totalEl) totalEl.textContent = formatMoney(total);

  const feeRow = feeEl?.closest(".totals__row");
  if (feeRow) feeRow.hidden = true;

  const taxRow = taxEl?.closest(".totals__row");
  if (taxRow) taxRow.hidden = true;

  const deliveryRow = deliveryEl?.closest(".totals__row");
  if (deliveryRow) deliveryRow.hidden = true;
};

const updateTotalsBlock = (container, totals) => {
  if (!container || !totals) return;
  const subtotalEl = container.querySelector("[data-subtotal]");
  const feeEl = container.querySelector("[data-fee]");
  const deliveryEl = container.querySelector("[data-delivery-fee]");
  const taxEl = container.querySelector("[data-tax]");
  const totalEl = container.querySelector("[data-total]");
  if (subtotalEl) subtotalEl.textContent = formatMoney(totals.subtotal);
  if (feeEl) feeEl.textContent = formatMoney(totals.processingFee);
  if (deliveryEl) {
    deliveryEl.textContent = formatMoney(totals.deliveryFee || 0);
    const deliveryRow = deliveryEl.closest(".totals__row");
    if (deliveryRow) deliveryRow.hidden = !(totals.deliveryFee > 0);
  }
  if (taxEl) taxEl.textContent = formatMoney(totals.tax);
  if (totalEl) totalEl.textContent = formatMoney(totals.total);
};

const updateCheckoutButton = (cartState) => {
  const checkoutButton = document.querySelector("[data-open-checkout]");
  if (!checkoutButton) return;
  const orderingEnabled = appSettings?.orderingEnabled ?? false;
  if (!orderingEnabled) {
    checkoutButton.disabled = true;
    return;
  }
  checkoutButton.disabled = false;
};

const updateClearCartButton = (cartState) => {
  const clearButton = document.querySelector("[data-clear-cart]");
  if (!clearButton) return;
  clearButton.disabled = getCartItemCount(cartState) === 0;
};

const updateCartBar = (cartState) => {
  const cartBar = document.querySelector("[data-cart-bar]");
  if (!cartBar) return;
  if (!appSettings?.orderingEnabled) {
    cartBar.hidden = true;
    document.body.style.paddingBottom = "";
    return;
  }
  const countEl = cartBar.querySelector("[data-cart-count]");
  const totalEl = cartBar.querySelector("[data-cart-total]");
  const itemCount = getCartItemCount(cartState);
  const { subtotal } = calculateTotals(cartState, checkoutState.orderType, false, false);

  if (countEl) countEl.textContent = itemCount;
  if (totalEl) totalEl.textContent = formatMoney(subtotal);

  if (itemCount === 0) {
    cartBar.hidden = true;
    document.body.style.paddingBottom = "";
    return;
  }

  // Delay padding update to ensure layout has the cart bar height.
  cartBar.hidden = false;
  requestAnimationFrame(() => {
    const barHeight = cartBar.offsetHeight || 0;
    document.body.style.paddingBottom = `${barHeight + 12}px`;
  });
};

let lastSyncedCartSnapshot = {};

// Centralized UI refresh for any cart mutation.
const syncUIAfterCartChange = (cartState, changedId) => {
  const previousSnapshot = lastSyncedCartSnapshot || {};
  let cartChanged = Boolean(changedId);

  const sanitizedCart = sanitizeCartForStock(cartState);
  if (!areCartsEqual(cartState, sanitizedCart)) {
    cart = sanitizedCart;
    saveCart(cart);
    cartState = cart;
    changedId = null;
    cartChanged = true;
  }

  if (!cartChanged && !areCartsEqual(previousSnapshot, cartState)) {
    cartChanged = true;
  }

  if (changedId) {
    updateMenuItemQtyById(changedId, getQty(cartState, changedId));
  } else {
    renderAllMenus(cartState);
  }
  renderCartList(cartState);
  updateCartTotals(cartState);
  updateClearCartButton(cartState);
  updateCheckoutButton(cartState);
  updateCartBar(cartState);
  if (showDeliveryMinWarning) {
    const state = getDeliveryMinState(cartState);
    if (!state.show || state.meetsMin) {
      showDeliveryMinWarning = false;
    }
  }
  renderDeliveryMinUI(cartState);

  if (isCheckoutOpen() && isReviewStepActive()) {
    renderCheckoutSummary(checkoutSummary, cartState);
    updateTotalsBlock(checkoutTotals, calculateTotals(cartState, checkoutState.orderType, true, true));
  }

  if (pendingOrder && cartChanged) {
    resetPendingPaymentUI("You changed your order. Please place the order again to continue to payment.");
  }

  lastSyncedCartSnapshot = { ...cartState };
};

let cart = {};

// --- DOM references ---
const modalPairs = [
  ["[data-empanadas]", "#empanadas-modal"],
  ["[data-alcapurrias]", "#alcapurrias-modal"],
  ["[data-quipes]", "#quipes-modal"],
  ["[data-pinchos]", "#pinchos-modal"],
  ["[data-sorullitos]", "#sorullitos-modal"],
  ["[data-tres-leches]", "#tres-leches-modal"],
  ["[data-juices]", "#juices-modal"],
  ["[data-beverages]", "#beverages-modal"],
];

const modalCloseButtons = document.querySelectorAll("[data-modal-close]");
const modalBackdrops = document.querySelectorAll(".modal");
const addDrinkButtons = document.querySelectorAll("[data-add-drink]");
const continueButtons = document.querySelectorAll("[data-continue]");
const menuButton = document.querySelector("[data-scroll-menu]");
const cartModal = document.querySelector("#cart-modal");
const checkoutModal = document.querySelector("#checkout-modal");
const confirmationModal = document.querySelector("#confirmation-modal");
const checkoutError = document.querySelector("[data-checkout-error]");
const checkoutStepsLabel = document.querySelector("[data-checkout-steps]");
const deliveryDisabledMsg = document.querySelector("[data-delivery-disabled-msg]");
const checkoutFieldName = document.querySelector('[data-field="name"]');
const checkoutFieldPhone = document.querySelector('[data-field="phone"]');
const checkoutFieldAddress = document.querySelector('[data-field="address"]');
const checkoutSummary = document.querySelector("[data-checkout-summary]");
const checkoutTotals = document.querySelector("[data-checkout-totals]");
const checkoutActions = document.querySelector("[data-checkout-actions]");
const confirmationSummary = document.querySelector("[data-confirmation-summary]");
const confirmationTotals = document.querySelector("[data-confirmation-totals]");
const confirmationOrderId = document.querySelector("[data-order-id]");
const confirmationNote = document.querySelector("[data-confirmation-note]");
const paymentSection = document.querySelector("[data-payment-section]");
const paymentError = document.querySelector("[data-payment-error]");
const paymentContainer = document.querySelector("#clover-payment-container");
const payNowBtn = document.querySelector("[data-pay-now]");
const editOrderBtn = document.querySelector("[data-edit-order]");
const placeOrderBtn = document.querySelector("[data-place-order]");

// --- Checkout state ---
let checkoutState = {
  name: "",
  phone: "",
  orderType: "pickup",
  address: "",
};

let pendingOrder = null;
let cloverConfig = null;
let cloverInstance = null;
let cloverElements = null;
let cloverFieldRefs = null;
let cloverInitPromise = null;
let cloverSdkPromise = null;
let cloverReady = false;

if (payNowBtn) payNowBtn.disabled = true;

const bootstrapApp = async () => {
  await fetchSettingsAndMenu();
  cart = sanitizeCartForStock(loadCart());
  saveCart(cart);
  renderAllMenus(cart);
  syncUIAfterCartChange(cart);
  updateCheckoutUI();
};

// --- Modal helpers ---
const openModal = (modal) => {
  if (!modal) return;
  modal.classList.add("is-open");
  document.body.style.overflow = "hidden";
};

const closeModal = (modal) => {
  if (!modal) return;
  modal.classList.remove("is-open");
  if (!document.querySelector(".modal.is-open")) {
    document.body.style.overflow = "";
  }
};

const scrollToDrinksSection = () => {
  const target = document.getElementById("drinks") || document.getElementById("juices");
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
};

function isCheckoutOpen() {
  return checkoutModal?.classList.contains("is-open");
}

function isReviewStepActive() {
  const stepReview = document.querySelector('[data-checkout-step="review"]');
  return stepReview && !stepReview.hidden;
}

function resetPendingPaymentUI(message) {
  pendingOrder = null;
  setPaymentError("");
  setPaymentSectionVisible(false);
  if (placeOrderBtn) {
    placeOrderBtn.disabled = false;
    placeOrderBtn.removeAttribute("aria-busy");
  }

  if (paymentContainer) {
    paymentContainer.innerHTML = "";
    delete paymentContainer.dataset.ready;
  }
  cloverFieldRefs = null;
  cloverElements = null;
  cloverInstance = null;
  cloverReady = false;
  setPayNowState(!cloverReady, "Pay Now");

  if (checkoutError) {
    if (message) {
      checkoutError.textContent = message;
      checkoutError.hidden = false;
    } else {
      checkoutError.textContent = "";
      checkoutError.hidden = true;
    }
  }

  if (isReviewStepActive()) {
    setCheckoutStep("review");
  }
}

// --- Checkout flow ---
const hydrateCheckoutInputsFromState = () => {
  if (checkoutFieldName) checkoutFieldName.value = checkoutState.name;
  if (checkoutFieldPhone) checkoutFieldPhone.value = checkoutState.phone;
  if (checkoutFieldAddress) checkoutFieldAddress.value = checkoutState.address;
};

const setCheckoutStep = (step) => {
  const stepDetails = document.querySelector('[data-checkout-step="details"]');
  const stepReview = document.querySelector('[data-checkout-step="review"]');
  if (stepDetails) stepDetails.hidden = step !== "details";
  if (stepReview) stepReview.hidden = step !== "review";
  if (checkoutStepsLabel) {
    if (step === "review" && pendingOrder) {
      checkoutStepsLabel.textContent = "Step 2 of 2: Review & Payment";
    } else {
      checkoutStepsLabel.textContent = step === "review" ? "Step 2 of 2: Review" : "Step 1 of 2: Details";
    }
  }
  if (paymentSection) {
    const showPayment = step === "review" && pendingOrder;
    paymentSection.hidden = !showPayment;
    if (checkoutActions) checkoutActions.hidden = showPayment;
  }
  renderDeliveryMinUI(cart);
};

// Single source of truth for delivery availability + address field behavior.
function updateCheckoutUI() {
  if (!appSettings) return;
  const addressField = document.querySelector("[data-delivery-address-field]");
  const addressInput = addressField?.querySelector('input[data-field="address"]');

  const pickupBtn = document.querySelector('[data-set-order-type="pickup"]');
  const deliveryBtn = document.querySelector('[data-set-order-type="delivery"]');
  const disabledMsg = document.querySelector("[data-delivery-disabled-msg]");

  if (!appSettings.deliveryEnabled) {
    checkoutState.orderType = "pickup";
    if (deliveryBtn) deliveryBtn.disabled = true;
    if (disabledMsg) disabledMsg.hidden = false;

    if (addressField) addressField.hidden = true;
    if (addressInput) addressInput.required = false;
  } else {
    if (deliveryBtn) deliveryBtn.disabled = false;
    if (disabledMsg) disabledMsg.hidden = true;

    const shouldShowAddress = checkoutState.orderType === "delivery";
    if (addressField) addressField.hidden = !shouldShowAddress;
    if (addressInput) addressInput.required = shouldShowAddress;
  }

  if (pickupBtn) {
    pickupBtn.classList.toggle("is-active", checkoutState.orderType === "pickup");
    pickupBtn.classList.toggle("segmented__btn--active", checkoutState.orderType === "pickup");
  }
  if (deliveryBtn) {
    deliveryBtn.classList.toggle("is-active", checkoutState.orderType === "delivery");
    deliveryBtn.classList.toggle("segmented__btn--active", checkoutState.orderType === "delivery");
  }

  if (checkoutState.orderType !== "delivery") {
    showDeliveryMinWarning = false;
  }
  renderDeliveryMinUI(cart);
}

const renderCheckoutSummary = (targetUl, cartState) => {
  if (!targetUl) return;
  const entries = Object.entries(cartState);
  if (entries.length === 0) {
    targetUl.innerHTML = '<li class="cart-empty">Your cart is empty</li>';
    return;
  }
  targetUl.innerHTML = entries
    .map(([id, qty]) => {
      const item = itemById[id];
      if (!item) return "";
      const lineTotal = item.price * qty;
      return `
        <li>
          <span>${item.name} × ${qty}</span>
          <span>${formatMoney(lineTotal)}</span>
        </li>
      `;
    })
    .join("");
};

const openCheckout = () => {
  if (!checkoutModal) return;
  if (!appSettings || !appSettings.orderingEnabled) {
    setOrderingClosedBanner(true);
    return;
  }

  // Remove sold-out items before any checkout validation.
  const sanitizedCart = sanitizeCartForStock(cart);
  if (!areCartsEqual(cart, sanitizedCart)) {
    cart = sanitizedCart;
    saveCart(cart);
    syncUIAfterCartChange(cart);
  }

  if (pendingOrder) {
    if (pendingOrder.orderType) {
      checkoutState.orderType = pendingOrder.orderType;
    }
    if (checkoutError) checkoutError.hidden = true;
    showDeliveryMinWarning = false;
    setCheckoutStep("review");
    renderCheckoutSummary(checkoutSummary, pendingOrder.cartSnapshot || cart);
    updateTotalsBlock(
      checkoutTotals,
      pendingOrder.totals || calculateTotals(pendingOrder.cartSnapshot || cart, checkoutState.orderType, true, true),
    );
    updateCheckoutUI();
    if (placeOrderBtn) placeOrderBtn.disabled = true;
    setPaymentSectionVisible(true);
    initCloverPayment();
    openModal(checkoutModal);
    return;
  }

  if (getCartItemCount(cart) === 0) {
    alert("Your cart is empty.");
    return;
  }

  if (checkoutError) checkoutError.hidden = true;
  showDeliveryMinWarning = false;
  setCheckoutStep("details");
  hydrateCheckoutInputsFromState();
  updateCheckoutUI();
  openModal(checkoutModal);
};

const readCheckoutFields = () => {
  checkoutState.name = (checkoutFieldName?.value || "").trim();
  checkoutState.phone = (checkoutFieldPhone?.value || "").trim();
  checkoutState.address = (checkoutFieldAddress?.value || "").trim();
};

const validateCheckoutDetails = () => {
  if (!appSettings || !appSettings.orderingEnabled) {
    setOrderingClosedBanner(true);
    return "Ordering is currently closed.";
  }
  showDeliveryMinWarning = false;
  renderDeliveryMinUI(cart);
  if (getCartItemCount(cart) === 0) {
    return "Your cart is empty. Add items before checking out.";
  }
  if (checkoutState.name.length === 0) {
    return "Please enter your name.";
  }
  if (checkoutState.phone.length === 0) {
    return "Please enter a valid phone number.";
  }
  const needsAddress = appSettings.deliveryEnabled && checkoutState.orderType === "delivery";
  if (needsAddress && checkoutState.address.length === 0) {
    return "Delivery address is required for delivery orders.";
  }
  if (appSettings.deliveryEnabled && checkoutState.orderType === "delivery") {
    const subtotal = getCartSubtotal(cart);
    if (subtotal < appSettings.deliveryMinTotal) {
      const shortfall = appSettings.deliveryMinTotal - subtotal;
      showDeliveryMinWarning = true;
      renderDeliveryMinUI(cart);
      return `Delivery minimum is ${formatMoney(appSettings.deliveryMinTotal)} before fees. Add ${formatMoney(
        shortfall,
      )} more.`;
    }
  }
  showDeliveryMinWarning = false;
  renderDeliveryMinUI(cart);
  return "";
};

const renderConfirmation = (orderId, cartSnapshot, totals, warnings = [], orderTypeOverride = "") => {
  if (confirmationOrderId) confirmationOrderId.textContent = orderId;
  renderCheckoutSummary(confirmationSummary, cartSnapshot);
  updateTotalsBlock(confirmationTotals, totals);
  if (confirmationNote) {
    if (Array.isArray(warnings) && warnings.length) {
      confirmationNote.textContent = "Order received; staff has been notified.";
    } else {
      const orderType = orderTypeOverride || checkoutState.orderType;
      confirmationNote.textContent =
        orderType === "pickup"
          ? "Pickup orders are typically ready within 15 minutes."
          : "We’ll contact you when your order is ready.";
    }
  }
};

const setPaymentError = (message) => {
  if (!paymentError) return;
  if (!message) {
    paymentError.textContent = "";
    paymentError.hidden = true;
    return;
  }
  paymentError.textContent = message;
  paymentError.hidden = false;
};

const setPaymentSectionVisible = (visible) => {
  if (!paymentSection) return;
  paymentSection.hidden = !visible;
  if (checkoutActions) checkoutActions.hidden = visible;
};

const setPayNowState = (disabled, label) => {
  if (!payNowBtn) return;
  payNowBtn.disabled = disabled;
  if (label) payNowBtn.textContent = label;
};

const fetchPaymentConfig = async () => {
  if (cloverConfig) return cloverConfig;
  const response = await fetch("/api/payments/config");
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.ok) {
    const message = getErrorMessage(data, "Could not load payment settings.");
    throw new Error(message);
  }
  cloverConfig = { merchantId: data.merchantId, publicKey: data.publicKey };
  return cloverConfig;
};

const loadCloverSdk = () => {
  if (window.Clover) return Promise.resolve();
  if (cloverSdkPromise) return cloverSdkPromise;
  cloverSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.clover.com/sdk.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Clover SDK."));
    document.head.appendChild(script);
  });
  cloverSdkPromise.catch(() => {
    cloverSdkPromise = null;
  });
  return cloverSdkPromise;
};

const scrollCheckoutModalToBottom = () => {
  const modalContent = checkoutModal?.querySelector(".modal__content");
  if (modalContent) {
    modalContent.scrollTop = modalContent.scrollHeight;
  }
};

const buildPaymentFieldsMarkup = () => {
  if (!paymentContainer || paymentContainer.dataset.ready) return;
  paymentContainer.innerHTML = `
    <div class="payment__grid">
      <div class="payment__field">
        <span class="payment__label">Card Number</span>
        <div id="clover-card-number" class="clover-field"></div>
        <div class="input-errors" id="clover-card-number-errors" role="alert"></div>
      </div>
      <div class="payment__row">
        <div class="payment__field">
          <span class="payment__label">Expiry</span>
          <div id="clover-card-date" class="clover-field"></div>
          <div class="input-errors" id="clover-card-date-errors" role="alert"></div>
        </div>
        <div class="payment__field">
          <span class="payment__label">CVV</span>
          <div id="clover-card-cvv" class="clover-field"></div>
          <div class="input-errors" id="clover-card-cvv-errors" role="alert"></div>
        </div>
        <div class="payment__field">
          <span class="payment__label">ZIP</span>
          <div id="clover-card-postal-code" class="clover-field"></div>
          <div class="input-errors" id="clover-card-postal-code-errors" role="alert"></div>
        </div>
      </div>
    </div>
  `;
  paymentContainer.dataset.ready = "true";
  scrollCheckoutModalToBottom();
};

const bindFieldErrors = (element, errorEl) => {
  if (!element || !errorEl) return;
  element.addEventListener("change", (event) => {
    if (event?.error && event.error.message) {
      errorEl.textContent = event.error.message;
      return;
    }
    errorEl.textContent = "";
  });
};

const initCloverPayment = () => {
  if (cloverReady) return Promise.resolve();
  if (cloverInitPromise) return cloverInitPromise;

  cloverInitPromise = (async () => {
    setPayNowState(true, "Loading payment...");
    setPaymentError("");

    const config = await fetchPaymentConfig();
    await loadCloverSdk();
    buildPaymentFieldsMarkup();

    if (!window.Clover) {
      throw new Error("Payment SDK unavailable.");
    }

    cloverInstance = new window.Clover(config.publicKey);
    cloverElements = cloverInstance.elements();

    const styleOptions = {
      styles: {
        base: {
          color: "#111111",
          fontSize: "14px",
          lineHeight: "20px",
          fontFamily: '"Source Sans 3", sans-serif',
          padding: "10px",
        },
        placeholder: {
          color: "rgba(0, 0, 0, 0.4)",
        },
        invalid: {
          color: "#8e1c1c",
        },
      },
    };

    const cardNumber = cloverElements.create("CARD_NUMBER", styleOptions);
    const cardDate = cloverElements.create("CARD_DATE", styleOptions);
    const cardCvv = cloverElements.create("CARD_CVV", styleOptions);
    const cardPostal = cloverElements.create("CARD_POSTAL_CODE", styleOptions);

    cardNumber.mount("#clover-card-number");
    cardDate.mount("#clover-card-date");
    cardCvv.mount("#clover-card-cvv");
    cardPostal.mount("#clover-card-postal-code");

    cloverFieldRefs = {
      cardNumber,
      cardDate,
      cardCvv,
      cardPostal,
    };

    scrollCheckoutModalToBottom();

    bindFieldErrors(cardNumber, document.querySelector("#clover-card-number-errors"));
    bindFieldErrors(cardDate, document.querySelector("#clover-card-date-errors"));
    bindFieldErrors(cardCvv, document.querySelector("#clover-card-cvv-errors"));
    bindFieldErrors(cardPostal, document.querySelector("#clover-card-postal-code-errors"));

    cloverReady = true;
    setPayNowState(false, "Pay Now");
  })()
    .catch((error) => {
      console.error("[payment] Clover init failed", error);
      setPaymentError("Payment form could not load. Please try again.");
      setPayNowState(true, "Pay Now");
    })
    .finally(() => {
      cloverInitPromise = null;
    });

  return cloverInitPromise;
};

const resetPaymentUI = () => {
  setPaymentError("");
  setPaymentSectionVisible(false);
  if (placeOrderBtn) placeOrderBtn.disabled = false;
  setPayNowState(!cloverReady, "Pay Now");
};

// --- Modal wiring ---
modalPairs.forEach(([triggerSelector, modalSelector]) => {
  const trigger = document.querySelector(triggerSelector);
  const modal = document.querySelector(modalSelector);
  if (!trigger || !modal) return;
  trigger.addEventListener("click", () => openModal(modal));
});

modalCloseButtons.forEach((button) => {
  button.addEventListener("click", (event) => {
    const modal = event.target.closest(".modal");
    closeModal(modal);
  });
});

modalBackdrops.forEach((modal) => {
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal(modal);
    }
  });
});

continueButtons.forEach((button) => {
  button.addEventListener("click", (event) => {
    const modal = event.target.closest(".modal");
    closeModal(modal);
  });
});

addDrinkButtons.forEach((button) => {
  button.addEventListener("click", (event) => {
    const modal = event.target.closest(".modal");
    closeModal(modal);
    setTimeout(scrollToDrinksSection, 200);
  });
});

// Close any open modal via ESC.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    document.querySelectorAll(".modal.is-open").forEach((modal) => {
      closeModal(modal);
    });
  }
});

// --- Event delegation ---
document.addEventListener("click", async (event) => {
  const openCart = event.target.closest("[data-open-cart]");
  if (openCart) {
    openModal(cartModal);
    return;
  }

  const openCheckoutButton = event.target.closest("[data-open-checkout]");
  if (openCheckoutButton) {
    openCheckout();
    return;
  }

  const setOrderTypeButton = event.target.closest("[data-set-order-type]");
  if (setOrderTypeButton) {
    const nextType = setOrderTypeButton.dataset.setOrderType;
    if (nextType === "delivery" && !appSettings.deliveryEnabled) return;
    if (nextType && nextType !== checkoutState.orderType) {
      checkoutState.orderType = nextType;
      updateCheckoutUI();
      updateCartTotals(cart);
      updateCartBar(cart);
      if (isCheckoutOpen() && isReviewStepActive()) {
        updateTotalsBlock(checkoutTotals, calculateTotals(cart, checkoutState.orderType, true, true));
      }
      if (pendingOrder) {
        resetPendingPaymentUI("Order type changed. Please place the order again to continue to payment.");
      }
    }
    return;
  }

  const continueCheckout = event.target.closest("[data-checkout-continue]");
  if (continueCheckout) {
    if (pendingOrder) {
      if (pendingOrder.orderType) {
        checkoutState.orderType = pendingOrder.orderType;
      }
      setCheckoutStep("review");
      renderCheckoutSummary(checkoutSummary, pendingOrder.cartSnapshot || cart);
      updateTotalsBlock(
        checkoutTotals,
        pendingOrder.totals || calculateTotals(pendingOrder.cartSnapshot || cart, checkoutState.orderType, true, true),
      );
      updateCheckoutUI();
      setPaymentSectionVisible(true);
      initCloverPayment();
      return;
    }
    readCheckoutFields();
    const errorMessage = validateCheckoutDetails();
    if (errorMessage) {
      if (checkoutError) {
        checkoutError.textContent = errorMessage;
        checkoutError.hidden = false;
      }
      return;
    }
    if (checkoutState.orderType === "delivery") {
      try {
        const resp = await fetch("/api/validate-delivery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: checkoutState.address }),
        });

        const data = await resp.json().catch(() => null);

        if (!resp.ok || !data || !data.ok) {
          const msg = getErrorMessage(data, "Could not validate delivery address.");
          if (checkoutError) {
            checkoutError.textContent = msg;
            checkoutError.hidden = false;
          }
          return;
        }

        if (!data.withinRadius) {
          const msg = `Delivery is available within ${data.radiusMiles} miles. Your address appears to be about ${data.distanceMiles} miles away.`;
          if (checkoutError) {
            checkoutError.textContent = msg;
            checkoutError.hidden = false;
          }
          return;
        }
      } catch (e) {
        if (checkoutError) {
          checkoutError.textContent = "Could not validate delivery address. Please try again.";
          checkoutError.hidden = false;
        }
        return;
      }
    }
    if (checkoutError) checkoutError.hidden = true;
    setCheckoutStep("review");
    renderCheckoutSummary(checkoutSummary, cart);
    updateTotalsBlock(checkoutTotals, calculateTotals(cart, checkoutState.orderType, true, true));
    return;
  }

  const backCheckout = event.target.closest("[data-checkout-back]");
  if (backCheckout) {
    setCheckoutStep("details");
    updateCheckoutUI();
    return;
  }

  const editOrder = event.target.closest("[data-edit-order]");
  if (editOrder) {
    // Close checkout + open cart so user can change items
    closeModal(checkoutModal);
    openModal(cartModal);

    // Also reset any pending payment state so they must place order again
    if (pendingOrder) {
      resetPendingPaymentUI("");
    }
    return;
  }

  const payNow = event.target.closest("[data-pay-now]");
  if (payNow) {
    if (!pendingOrder) {
      setPaymentError("Please place your order first.");
      return;
    }

    setPaymentError("");
    setPayNowState(true, "Processing...");
    payNow.setAttribute("aria-busy", "true");

    try {
      await initCloverPayment();

      if (!cloverInstance) {
        throw new Error("Payment is unavailable.");
      }

      const tokenResult = await cloverInstance.createToken();
      const sourceId = tokenResult?.token;
      const tokenError =
        tokenResult?.errors?.[0]?.message || tokenResult?.error?.message || tokenResult?.error || "";

      if (!sourceId) {
        setPaymentError(tokenError || "Please check your card details and try again.");
        return;
      }
      if (!sourceId.startsWith("clv_")) {
        setPaymentError("Payment token is invalid. Please try again.");
        return;
      }

      const response = await fetch("/api/payments/iframe/charge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order_id: String(pendingOrder.order_id),
          source_id: sourceId,
          orderId: String(pendingOrder.order_id),
          sourceId: sourceId,
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !data.ok) {
        const message = getErrorMessage(data, "Payment was declined. Please try another card.");
        setPaymentError(message);
        return;
      }

      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      renderConfirmation(
        pendingOrder.order_code,
        pendingOrder.cartSnapshot,
        pendingOrder.totals,
        warnings,
        pendingOrder.orderType,
      );
      clearCart();
      closeModal(checkoutModal);
      openModal(confirmationModal);
      pendingOrder = null;
      resetPaymentUI();
    } catch (error) {
      setPaymentError("Payment could not be processed. Please try again.");
    } finally {
      payNow.removeAttribute("aria-busy");
      setPayNowState(!cloverReady, "Pay Now");
    }
    return;
  }

  const placeOrder = event.target.closest("[data-place-order]");
  if (placeOrder) {
    if (pendingOrder) {
      if (checkoutError) {
        checkoutError.textContent = "Payment is already started. Please complete payment below.";
        checkoutError.hidden = false;
      }
      setCheckoutStep("review");
      setPaymentSectionVisible(true);
      initCloverPayment();
      return;
    }
    if (getCartItemCount(cart) === 0) {
      alert("Your cart is empty.");
      return;
    }
    readCheckoutFields();
    const errorMessage = validateCheckoutDetails();
    if (errorMessage) {
      if (checkoutError) {
        checkoutError.textContent = errorMessage;
        checkoutError.hidden = false;
      }
      return;
    }
    if (checkoutError) checkoutError.hidden = true;

    const cartSnapshot = { ...cart };
    const totals = calculateTotals(cartSnapshot, checkoutState.orderType, true, true);
    const payload = {
      customer_name: checkoutState.name,
      customer_phone: checkoutState.phone,
      fulfillment_type: checkoutState.orderType,
      delivery_address: checkoutState.orderType === "delivery" ? checkoutState.address : null,
      items: Object.entries(cartSnapshot).map(([id, qty]) => ({ id: Number(id), qty })),
    };

    placeOrder.disabled = true;
    placeOrder.setAttribute("aria-busy", "true");

    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !data.ok) {
        const message = getErrorMessage(data, "Could not place order. Please try again.");
        if (checkoutError) {
          checkoutError.textContent = message;
          checkoutError.hidden = false;
        }
        return;
      }

      if (!data.order_id) {
        throw new Error("Order id missing from server response.");
      }

      const serverTotal = Number(data.total_cents) / 100;
      if (Number.isFinite(serverTotal) && Math.abs(serverTotal - totals.total) > 0.009) {
        totals.total = serverTotal;
      }

      pendingOrder = {
        order_id: data.order_id,
        order_code: data.order_code || `DCO-${Math.floor(10000 + Math.random() * 90000)}`,
        total_cents: data.total_cents,
        cartSnapshot,
        totals,
        orderType: checkoutState.orderType,
      };

      setPaymentError("");
      if (checkoutError) checkoutError.hidden = true;
      setCheckoutStep("review");
      updateTotalsBlock(checkoutTotals, totals);
      if (placeOrderBtn) placeOrderBtn.disabled = true;
      setPaymentSectionVisible(true);
      initCloverPayment();
    } catch (error) {
      if (checkoutError) {
        checkoutError.textContent = "Could not place order. Please try again.";
        checkoutError.hidden = false;
      }
    } finally {
      if (!pendingOrder) {
        placeOrder.disabled = false;
        placeOrder.removeAttribute("aria-busy");
      } else {
        placeOrder.removeAttribute("aria-busy");
      }
    }
    return;
  }

  const closeConfirmation = event.target.closest("[data-close-confirmation]");
  if (closeConfirmation) {
    closeModal(confirmationModal);
    return;
  }

  const clearCartButton = event.target.closest("[data-clear-cart]");
  if (clearCartButton) {
    if (getCartItemCount(cart) === 0) return;
    clearCart();
    return;
  }

  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) return;
  const itemEl = actionEl.closest("[data-id]");
  if (!itemEl) return;
  const id = itemEl.dataset.id;
  if (!id) return;

  const action = actionEl.dataset.action;
  const item = itemById[id];
  if ((action === "add" || action === "increase") && item && item.inStock === false) {
    alert("This item is currently sold out.");
    return;
  }
  if (action === "add") {
    setQty(cart, id, 1);
  } else if (action === "increase") {
    increment(cart, id);
  } else if (action === "decrease") {
    decrement(cart, id);
  } else {
    return;
  }

  saveCart(cart);
  syncUIAfterCartChange(cart, id);
});

// Smooth scroll for the hero "View Menu" button.
if (menuButton) {
  menuButton.addEventListener("click", (event) => {
    event.preventDefault();
    const target = document.querySelector(menuButton.getAttribute("href"));
    if (target) {
      target.scrollIntoView({ behavior: "smooth" });
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    if ("scrollRestoration" in history) {
      history.scrollRestoration = "manual";
    }
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    window.scrollTo(0, 0);
    bootstrapApp();
  });
} else {
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }
  if (window.location.hash) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  window.scrollTo(0, 0);
  bootstrapApp();
}
