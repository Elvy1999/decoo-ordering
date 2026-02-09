const TOKEN_KEY = "STAFF_TOKEN";
// Poll interval in ms (approx every 5-7s; using 6000ms midpoint)
const POLL_INTERVAL_MS = 6000;
const LAST_SEEN_KEY = "LAST_SEEN_ORDER_TIMESTAMP";
const REALTIME_CHANNEL = "staff-orders-live";

const loginPanel = document.getElementById("login-panel");
const staffApp = document.getElementById("staff-app");
const loginForm = document.getElementById("login-form");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const tokenInput = document.getElementById("staff-token-input");
const refreshBtn = document.getElementById("refresh-btn");
const ordersListEl = document.getElementById("orders-list");
const detailsPanelEl = document.getElementById("details-panel");
const toastEl = document.getElementById("toast");

const supabaseLib = window.supabase;
const createClient = supabaseLib?.createClient;

const SOUND_START_SEC = 46;
const SOUND_DURATION_SEC = 8;
const orderSound = new Audio("/order_sound.mp3");
orderSound.preload = "auto";
orderSound.volume = 0.7;
let soundStopTimer = null;

const enableSoundBtn = document.getElementById("enable-sound");
let audioEnabled = sessionStorage.getItem("audioEnabled") === "1";
if (audioEnabled && enableSoundBtn) enableSoundBtn.hidden = true;

let orders = [];
let selectedOrderId = null;
let updatingOrderIds = new Set();
let knownPaidOrderIds = new Set();
let hasHydratedOrders = false;
let pollTimer = null;
let refreshDebounceTimer = null;
let supabaseClient = null;
let realtimeChannel = null;

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });

const showToast = (message, type = "success") => {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = `toast show toast--${type}`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.className = "toast";
  }, 2400);
};

const setAuthState = (isAuthed) => {
  if (loginPanel) loginPanel.hidden = isAuthed;
  if (staffApp) staffApp.hidden = !isAuthed;
  if (logoutBtn) logoutBtn.style.display = isAuthed ? "inline-flex" : "none";
};

const getToken = () => localStorage.getItem(TOKEN_KEY) || "";

const parseErrorMessage = (payload, fallback, status) => {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error?.message === "string") return payload.error.message;
  if (typeof payload?.message === "string") return payload.message;
  if (status === 401) return "Unauthorized";
  return fallback;
};

const normalizeApiPath = (path) => {
  const raw = String(path || "").trim();
  if (!raw) return "/";

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw, window.location.origin);
    if (/decoorestaurant\.com$/i.test(url.hostname)) {
      return `${url.pathname}${url.search}`;
    }
    if (url.origin !== window.location.origin) {
      throw new Error("Cross-origin API calls are not allowed.");
    }
    return `${url.pathname}${url.search}`;
  }

  const cleaned = raw.replace(/^\.\/+/, "");
  if (cleaned.startsWith("api/")) return `/${cleaned}`;
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
};

const apiFetch = async (path, { method = "GET", body, token, suppressUnauthorizedHandler = false } = {}) => {
  const headers = { Accept: "application/json" };
  const authToken = token ?? getToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(normalizeApiPath(path), { method, headers, body: payload });
  const raw = await response.text();

  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (response.status === 401) {
    if (!suppressUnauthorizedHandler) handleUnauthorized();
    const unauthorizedError = new Error("Unauthorized");
    unauthorizedError.status = 401;
    throw unauthorizedError;
  }

  if (!response.ok) {
    const error = new Error(parseErrorMessage(data, `Request failed (${response.status})`, response.status));
    error.status = response.status;
    throw error;
  }

  return data;
};

const fetchStaffOrders = async ({ token, suppressUnauthorizedHandler = false } = {}) => {
  const headers = { Accept: "application/json" };
  const authToken = token ?? getToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const response = await fetch("/api/staff/orders", { method: "GET", headers });
  const raw = await response.text();

  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (response.status === 401) {
    if (!suppressUnauthorizedHandler) handleUnauthorized();
    const unauthorizedError = new Error("Unauthorized");
    unauthorizedError.status = 401;
    throw unauthorizedError;
  }

  if (!response.ok) {
    const error = new Error(parseErrorMessage(data, `Request failed (${response.status})`, response.status));
    error.status = response.status;
    throw error;
  }

  return data;
};

const validateToken = async (token) => {
  if (!token) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
  await fetchStaffOrders({ token, suppressUnauthorizedHandler: true });
};

const formatMoney = (cents) => {
  const amount = Number(cents) / 100;
  if (!Number.isFinite(amount)) return "$0.00";
  return `$${amount.toFixed(2)}`;
};

const formatDateTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatFulfillmentType = (value) => {
  if (value === "pickup") return "Recogida";
  if (value === "delivery") return "Entrega";
  return value || "-";
};

const isPaidOrder = (order) => order?.payment_status === "paid" || Boolean(order?.paid_at);
const normalize = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const isDrinkCategory = (category) => {
  const c = normalize(category);
  return c === "juices" || c === "sodas" || c === "soda" || c === "drinks";
};
const isDrinkByName = (name) => {
  const n = normalize(name);
  return n.includes("juice") || n.includes("soda") || n.includes("coke") || n.includes("sprite");
};
const sortItemsWithDrinksLast = (items = []) =>
  [...items].sort((a, b) => {
    const aDrink = isDrinkCategory(a?.category) || (!a?.category && isDrinkByName(a?.name || a?.item_name));
    const bDrink = isDrinkCategory(b?.category) || (!b?.category && isDrinkByName(b?.name || b?.item_name));
    if (aDrink === bDrink) return 0;
    return aDrink ? 1 : -1;
  });

const isCompletedOrder = (order) => String(order?.status || "").toLowerCase() === "completed";
const getOrderTimeValue = (order) => order?.paid_at || order?.created_at || null;

const findSelectedOrder = () => orders.find((order) => String(order.id) === String(selectedOrderId)) || null;

const renderOrders = () => {
  if (!ordersListEl) return;
  ordersListEl.innerHTML = "";

  if (!orders.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aun no hay pedidos pagados.";
    ordersListEl.appendChild(empty);
    return;
  }

  orders.forEach((order) => {
    const idKey = String(order.id);
    const completed = isCompletedOrder(order);
    const items = Array.isArray(order.items) ? order.items : [];
    const sortedItems = sortItemsWithDrinksLast(items);
    const row = document.createElement("article");
    row.className = `order-row${idKey === String(selectedOrderId) ? " is-selected" : ""}`;

    const cardInner = document.createElement("div");
    cardInner.className = "order-card-main";

    const left = document.createElement("section");
    left.className = "order-left";
    left.innerHTML = `
      <div class="order-code">${escapeHtml(`#${order.id}`)}</div>
      <div class="order-meta">${escapeHtml(order.customer_name || "-")}</div>
      <div class="order-meta">${escapeHtml(order.customer_phone || "-")}</div>
      <div class="order-type"><strong>${formatFulfillmentType(order.fulfillment_type)}</strong></div>
      <div class="order-time">${escapeHtml(formatDateTime(getOrderTimeValue(order)))}</div>
    `;

    const controls = document.createElement("div");
    controls.className = "order-controls";

    const pill = document.createElement("span");
    pill.className = `pill ${completed ? "pill--done" : "pill--open"}`;
    pill.textContent = completed ? "Completado" : "Abierto";

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = `order-toggle${completed ? " done" : ""}`;
    toggleBtn.disabled = updatingOrderIds.has(idKey);
    toggleBtn.textContent = completed ? "Marcar como abierto" : "Marcar como completado";
    toggleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void updateCompletion(order, !completed);
    });

    controls.appendChild(pill);
    controls.appendChild(toggleBtn);
    left.appendChild(controls);

    const itemsCol = document.createElement("section");
    itemsCol.className = "order-items";

    if (sortedItems.length) {
      for (const item of sortedItems) {
        const itemRow = document.createElement("div");
        itemRow.className = "order-item-row";

        const name = document.createElement("span");
        name.className = "order-item-name";
        name.textContent = String(item?.item_name || "Item");

        const qty = document.createElement("span");
        qty.className = "order-item-qty";
        qty.textContent = `x${Number(item?.qty || 0)}`;

        itemRow.appendChild(name);
        itemRow.appendChild(qty);
        itemsCol.appendChild(itemRow);
      }
    } else {
      const emptyItem = document.createElement("div");
      emptyItem.className = "order-item-row";
      emptyItem.innerHTML = `<span class="order-item-name">${escapeHtml("No items")}</span><span class="order-item-qty">-</span>`;
      itemsCol.appendChild(emptyItem);
    }

    cardInner.appendChild(left);
    cardInner.appendChild(itemsCol);
    row.appendChild(cardInner);

    row.addEventListener("click", () => {
      selectedOrderId = idKey;
      renderOrders();
      renderDetails();
    });

    ordersListEl.appendChild(row);
  });
};

const renderDetails = () => {
  if (!detailsPanelEl) return;
  const order = findSelectedOrder();

  if (!order) {
    detailsPanelEl.innerHTML = `
      <h3>Detalles del pedido</h3>
      <p class="helper">Selecciona un pedido para ver detalles.</p>
    `;
    return;
  }

  const items = Array.isArray(order.items) ? order.items : [];
  const sortedItems = sortItemsWithDrinksLast(items);
  const itemsMarkup =
    sortedItems.length > 0
      ? sortedItems
          .map((item) => {
            const qty = Number(item?.qty || 0);
            const lineTotal = Number.isFinite(Number(item?.line_total_cents))
              ? Number(item?.line_total_cents)
              : Number(item?.unit_price_cents || 0) * qty;
            return `<li><span>${escapeHtml(item?.item_name || "Item")} x ${qty}</span><strong>${formatMoney(lineTotal)}</strong></li>`;
          })
          .join("")
      : "<li><span>No items</span><strong>-</strong></li>";

  const deliveryAddress =
    order.fulfillment_type === "delivery" && order.delivery_address
      ? `<div class="details-block"><strong>Direccion de entrega:</strong> ${escapeHtml(order.delivery_address)}</div>`
      : "";

  const notes = String(order.notes || "").trim();
  const notesMarkup = notes
    ? `<div class="details-block"><strong>Notas</strong><div class="note">${escapeHtml(notes)}</div></div>`
    : "";
  const discountCents = Number(order.discount_cents || 0);
  const discountLabel = discountCents > 0 ? `-${formatMoney(discountCents)}` : formatMoney(discountCents);

  detailsPanelEl.innerHTML = `
    <h3>Pedido ${escapeHtml(`#${order.id}`)}</h3>
    <p class="helper">Hora de pago: ${escapeHtml(formatDateTime(getOrderTimeValue(order)))}</p>

    <div class="details-block">
      <div class="details-grid">
        <div><span>Cliente</span><br /><strong>${escapeHtml(order.customer_name || "-")}</strong></div>
        <div><span>Telefono</span><br /><strong>${escapeHtml(order.customer_phone || "-")}</strong></div>
        <div><span>Tipo</span><br /><strong>${escapeHtml(formatFulfillmentType(order.fulfillment_type))}</strong></div>
        <div><span>Estado</span><br /><strong>${isCompletedOrder(order) ? "Completado" : "Abierto"}</strong></div>
      </div>
    </div>

    ${deliveryAddress}

    <div class="details-block">
      <strong>Articulos</strong>
      <ul class="items-list">${itemsMarkup}</ul>
    </div>

    <div class="details-block">
      <strong>Totales</strong>
      <div class="totals">
        <div class="totals-row"><span>Subtotal</span><strong>${formatMoney(order.subtotal_cents)}</strong></div>
        <div class="totals-row"><span>Cargo de procesamiento</span><strong>${formatMoney(order.processing_fee_cents)}</strong></div>
        <div class="totals-row"><span>Cargo de entrega</span><strong>${formatMoney(order.delivery_fee_cents)}</strong></div>
        <div class="totals-row"><span>Descuento</span><strong>${discountLabel}</strong></div>
        <div class="totals-row total"><span>Total</span><strong>${formatMoney(order.total_cents)}</strong></div>
      </div>
    </div>

    ${notesMarkup}
  `;
};

const ensureSoundReady = () =>
  new Promise((resolve) => {
    if (orderSound.readyState >= 1) {
      resolve();
      return;
    }
    orderSound.addEventListener("loadedmetadata", () => resolve(), { once: true });
  });

const playOrderSound = async () => {
  if (!audioEnabled) {
    showToast("Toca Activar sonido", "error");
    return;
  }
  try {
    await ensureSoundReady();
    orderSound.currentTime = SOUND_START_SEC;
    await orderSound.play();

    clearTimeout(soundStopTimer);
    soundStopTimer = setTimeout(() => {
      orderSound.pause();
      orderSound.currentTime = SOUND_START_SEC;
    }, SOUND_DURATION_SEC * 1000);
  } catch (e) {
    showToast("Toca Activar sonido", "error");
  }
};

const applyOrders = (nextOrders) => {
  const paidOrders = (Array.isArray(nextOrders) ? nextOrders : []).filter(isPaidOrder);
  orders = paidOrders;

  if (!selectedOrderId && orders.length) {
    selectedOrderId = String(orders[0].id);
  } else if (selectedOrderId && !orders.some((order) => String(order.id) === String(selectedOrderId))) {
    selectedOrderId = orders.length ? String(orders[0].id) : null;
  }

  renderOrders();
  renderDetails();

  hasHydratedOrders = true;
};

// Poll once and detect newest paid order; handles alerting via sound once per new order.
const pollOnce = async ({ silent = false } = {}) => {
  try {
    const data = await fetchStaffOrders();
    // apply orders for rendering
    applyOrders(data);

    // determine newest paid order time value
    const paid = (Array.isArray(data) ? data : []).filter(isPaidOrder);
    if (!paid.length) return;

    paid.sort((a, b) => {
      const ta = getOrderTimeValue(a) || "";
      const tb = getOrderTimeValue(b) || "";
      if (ta > tb) return -1;
      if (ta < tb) return 1;
      return 0;
    });

    const newest = paid[0];
    const newestTime = getOrderTimeValue(newest);
    if (!newestTime) return;

    const stored = localStorage.getItem(LAST_SEEN_KEY);
    if (!stored) {
      // first poll: set but do not alert
      localStorage.setItem(LAST_SEEN_KEY, String(newestTime));
      return;
    }

    if (String(newestTime) > String(stored)) {
      // new order detected
      await playOrderSound();
      localStorage.setItem(LAST_SEEN_KEY, String(newestTime));
      showToast("Nuevo pedido pagado");
    }
  } catch (error) {
    if (!silent) showToast(error.message || "No se pudieron cargar los pedidos", "error");
  }
};

const loadOrders = async ({ silent = false } = {}) => {
  return pollOnce({ silent });
};

const updateCompletion = async (order, completed) => {
  const idKey = String(order.id);
  if (updatingOrderIds.has(idKey)) return;

  updatingOrderIds.add(idKey);
  renderOrders();

  try {
    const updated = await apiFetch(`/api/staff/orders/${encodeURIComponent(order.id)}/complete`, {
      method: "POST",
      body: { completed },
    });
    const nextStatus =
      typeof updated?.status === "string" ? updated.status : completed ? "completed" : "paid";
    orders = orders.map((row) => (String(row.id) === idKey ? { ...row, status: nextStatus } : row));
    showToast(completed ? "Marcado como completado" : "Marcado como abierto");
  } catch (error) {
    showToast(error?.status === 401 ? "No autorizado" : "No se pudo actualizar", "error");
  } finally {
    updatingOrderIds.delete(idKey);
    renderOrders();
    renderDetails();
  }
};

const getSupabaseClient = () => {
  if (!createClient) return null;
  if (supabaseClient) return supabaseClient;

  const url = window.PUBLIC_SUPABASE_URL;
  const anonKey = window.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  supabaseClient = createClient(url, anonKey);
  return supabaseClient;
};

const scheduleOrdersRefresh = () => {
  if (refreshDebounceTimer) return;
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null;
    void loadOrders({ silent: true });
  }, 350);
};

const startRealtime = () => {
  const client = getSupabaseClient();
  if (!client) return;

  if (realtimeChannel) {
    client.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  realtimeChannel = client
    .channel(REALTIME_CHANNEL)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, (payload) => {
      if (isPaidOrder(payload?.new)) scheduleOrdersRefresh();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders" }, (payload) => {
      if (isPaidOrder(payload?.new) || isPaidOrder(payload?.old)) scheduleOrdersRefresh();
    })
    .subscribe();
};

const stopRealtime = () => {
  if (!realtimeChannel) return;
  const client = getSupabaseClient();
  if (client) client.removeChannel(realtimeChannel);
  realtimeChannel = null;
};

const startPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // run immediately
  void pollOnce({ silent: true });

  // repeat at roughly POLL_INTERVAL_MS
  pollTimer = setInterval(() => {
    void pollOnce({ silent: true });
  }, POLL_INTERVAL_MS);
};

const stopLiveUpdates = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = null;
  }
  stopRealtime();
};

const resetOrdersState = () => {
  orders = [];
  selectedOrderId = null;
  updatingOrderIds = new Set();
  knownPaidOrderIds = new Set();
  hasHydratedOrders = false;
  renderOrders();
  renderDetails();
};

const handleUnauthorized = () => {
  localStorage.removeItem(TOKEN_KEY);
  stopLiveUpdates();
  setAuthState(false);
  resetOrdersState();
  showToast("No autorizado", "error");
};

const startAuthedSession = async (token, { showWelcome = false } = {}) => {
  await validateToken(token);
  localStorage.setItem(TOKEN_KEY, token);
  setAuthState(true);
  await loadOrders();
  startRealtime();
  startPolling();
  if (showWelcome) showToast("Sesion iniciada");
};

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!loginBtn || !tokenInput) return;

  const token = tokenInput.value.trim();
  if (!token) {
    showToast("Ingresa tu token de personal", "error");
    return;
  }

  loginBtn.disabled = true;
  try {
    await startAuthedSession(token, { showWelcome: true });
    tokenInput.value = "";
  } catch (error) {
    localStorage.removeItem(TOKEN_KEY);
    setAuthState(false);
    resetOrdersState();
    showToast(error?.status === 401 ? "No autorizado" : error.message || "Inicio de sesion fallido", "error");
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn?.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  stopLiveUpdates();
  setAuthState(false);
  resetOrdersState();
  showToast("Sesion cerrada");
});

refreshBtn?.addEventListener("click", () => {
  void loadOrders();
});

// Enable sound button: user gesture to unlock audio on mobile browsers
enableSoundBtn?.addEventListener("click", async () => {
  try {
    enableSoundBtn.disabled = true;
    // attempt a quick play/pause sequence to unlock audio
    try {
      await orderSound.play();
      orderSound.pause();
      orderSound.currentTime = 0;
    } catch (e) {
      // ignore - some browsers block play until user gesture
    }
    sessionStorage.setItem("audioEnabled", "1");
    audioEnabled = true;
    if (enableSoundBtn) enableSoundBtn.hidden = true;
    showToast("Sonido activado");
  } finally {
    if (enableSoundBtn) enableSoundBtn.disabled = false;
  }
});

const initialize = async () => {
  setAuthState(false);
  resetOrdersState();

  const token = getToken();
  if (!token) return;

  try {
    await startAuthedSession(token);
  } catch (error) {
    localStorage.removeItem(TOKEN_KEY);
    setAuthState(false);
    resetOrdersState();
    showToast(error?.status === 401 ? "No autorizado" : "Sesion expirada", "error");
  }
};

initialize();
