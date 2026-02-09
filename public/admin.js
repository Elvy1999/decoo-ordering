const supabaseLib = window.supabase;
const createClient = supabaseLib?.createClient;

if (!createClient) {
  console.error(
    "Supabase UMD bundle not available. Ensure https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js is loaded before admin.js.",
  );
}

const TOKEN_KEY = "ADMIN_TOKEN";
const REALTIME_CHANNEL = "admin-orders";
// In api/[...route].js, admin handlers are addressed via route=admin/<endpoint>.
const ADMIN_ROUTE_BASE = "/api/admin?route=admin/";
const ADMIN_SETTINGS_PATH = `${ADMIN_ROUTE_BASE}settings`;
const ADMIN_MENU_PATH = `${ADMIN_ROUTE_BASE}menu`;
const ADMIN_MENU_ITEM_PATH = `${ADMIN_ROUTE_BASE}menu-item`;
const ADMIN_ORDERS_PATH = `${ADMIN_ROUTE_BASE}orders`;
const ADMIN_ORDER_PATH = `${ADMIN_ROUTE_BASE}order`;
const ADMIN_PROMO_CODES_PATH = `${ADMIN_ROUTE_BASE}promo-codes`;
const ADMIN_PROMO_CODE_PATH = `${ADMIN_ROUTE_BASE}promo-code`;
const ADMIN_REPRINT_PATH = "/api/admin?route=reprint";

const newOrderSound = new Audio("/order_sound.mp3");
newOrderSound.volume = 0.7;

const loginPanel = document.getElementById("login-panel");
const adminPanels = document.getElementById("admin-panels");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const tokenInput = document.getElementById("admin-token");
const toastEl = document.getElementById("toast");

const settingsStatus = document.getElementById("settings-status");
const settingsForm = document.getElementById("settings-form");
const settingsSaveBtn = document.getElementById("settings-save");

const menuSearch = document.getElementById("menu-search");
const menuGroups = document.getElementById("menu-groups");

const ordersBody = document.getElementById("orders-body");
const ordersTableWrapper = document.getElementById("orders-table-wrapper");
const ordersTable = document.querySelector(".orders-table");
const ordersRefreshBtn = document.getElementById("orders-refresh");
const ordersStatusHeader = document.getElementById("orders-status-header");
const orderDetail = document.getElementById("order-detail");
const promoForm = document.querySelector("[data-promo-form]");
const promoCodeInput = document.querySelector("[data-promo-code]");
const promoTypeSelect = document.querySelector("[data-promo-type]");
const promoValueInput = document.querySelector("[data-promo-value]");
const promoMinInput = document.querySelector("[data-promo-min]");
const promoActiveInput = document.querySelector("[data-promo-active]");
const promoTableBody = document.querySelector("[data-promo-table]");
const promoError = document.querySelector("[data-promo-error]");
const promoSuccess = document.querySelector("[data-promo-success]");
const promoValueHint = document.querySelector("[data-promo-value-hint]");

let menuItems = [];
let orders = [];
let supabaseClient = null;
let realtimeChannel = null;
let ordersRefreshTimer = null;
window.__promoCache = window.__promoCache || [];

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
  loginPanel.hidden = isAuthed;
  adminPanels.hidden = !isAuthed;
  logoutBtn.style.display = isAuthed ? "inline-flex" : "none";
};

const getToken = () => sessionStorage.getItem(TOKEN_KEY);

const getSupabaseClient = () => {
  if (!createClient) {
    console.warn("Cliente de Supabase no disponible; tiempo real deshabilitado.");
    return null;
  }
  if (supabaseClient) return supabaseClient;
  const url = window.PUBLIC_SUPABASE_URL;
  const anonKey = window.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.warn("Faltan credenciales publicas de Supabase; tiempo real deshabilitado.");
    return null;
  }
  supabaseClient = createClient(url, anonKey);
  return supabaseClient;
};

const handleUnauthorized = () => {
  sessionStorage.removeItem(TOKEN_KEY);
  setAuthState(false);
  stopRealtime();
  showToast("La sesion expiro. Inicia sesion de nuevo.", "error");
};

const apiFetch = async (path, { method = "GET", body, token, suppressUnauthorizedHandler = false } = {}) => {
  const headers = {};
  const authToken = token ?? getToken();
  if (authToken) headers["x-admin-token"] = authToken;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(path, { method, headers, body: payload });
  if (response.status === 401) {
    if (!suppressUnauthorizedHandler) handleUnauthorized();
    const error = new Error("No autorizado");
    error.status = 401;
    throw error;
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const message = data?.error?.message || `La solicitud fallo (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
};

const validateToken = async (token) => {
  if (!token) {
    const error = new Error("Token invalido");
    error.status = 401;
    throw error;
  }

  try {
    await apiFetch(ADMIN_SETTINGS_PATH, { token, suppressUnauthorizedHandler: true });
  } catch (error) {
    if (error?.status === 401) {
      const mapped = new Error("Token invalido");
      mapped.status = 401;
      throw mapped;
    }
    if (error?.status === 404) {
      const mapped = new Error("No se encontro la ruta del API de admin");
      mapped.status = 404;
      throw mapped;
    }
    if (typeof error?.status === "number" && error.status >= 500) {
      const mapped = new Error("Error del servidor");
      mapped.status = error.status;
      throw mapped;
    }
    throw error;
  }

  return true;
};

const adminFetch = async (url, options = {}) => apiFetch(url, options);

const dollarsToCents = (d) => Math.round(Number(d || 0) * 100);
const centsToDollars = (c) => (Number(c || 0) / 100).toFixed(2);
const normalizeCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });

const formatMoney = (cents) => {
  const value = Number(cents) / 100;
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
};

const formatFulfillmentType = (value) => {
  if (value === "delivery") return "Entrega";
  if (value === "pickup") return "Recoger";
  return value || "-";
};

const setSettingsStatus = (label, tone = "idle") => {
  if (!settingsStatus) return;
  settingsStatus.textContent = label;
  settingsStatus.style.background = tone === "error" ? "#f8d7da" : "#f4e8dc";
  settingsStatus.style.color = tone === "error" ? "#842029" : "#5c4a3c";
};

const fillSettingsForm = (settings) => {
  settingsForm.ordering_enabled.checked = Boolean(settings?.ordering_enabled);
  settingsForm.delivery_enabled.checked = Boolean(settings?.delivery_enabled);
  settingsForm.delivery_radius_miles.value = settings?.delivery_radius_miles ?? "";
  settingsForm.processing_fee_cents.value = settings?.processing_fee_cents ?? "";
  settingsForm.delivery_fee_cents.value = settings?.delivery_fee_cents ?? "";
  settingsForm.delivery_min_total_cents.value = settings?.delivery_min_total_cents ?? "";
};

const loadSettings = async () => {
  setSettingsStatus("Cargando...");
  try {
    const settings = await apiFetch(ADMIN_SETTINGS_PATH);
    fillSettingsForm(settings);
    setSettingsStatus("Cargado");
  } catch (error) {
    setSettingsStatus("Error", "error");
    showToast(error.message || "No se pudo cargar la configuracion.", "error");
  }
};

const saveSettings = async (event) => {
  event.preventDefault();
  settingsSaveBtn.disabled = true;
  setSettingsStatus("Guardando...");
  try {
    const payload = {
      ordering_enabled: settingsForm.ordering_enabled.checked,
      delivery_enabled: settingsForm.delivery_enabled.checked,
      delivery_radius_miles: Number(settingsForm.delivery_radius_miles.value || 0),
      processing_fee_cents: Number(settingsForm.processing_fee_cents.value || 0),
      delivery_fee_cents: Number(settingsForm.delivery_fee_cents.value || 0),
      delivery_min_total_cents: Number(settingsForm.delivery_min_total_cents.value || 0),
    };
    const updated = await apiFetch(ADMIN_SETTINGS_PATH, { method: "PATCH", body: payload });
    fillSettingsForm(updated);
    setSettingsStatus("Guardado");
    showToast("Configuracion actualizada.");
  } catch (error) {
    setSettingsStatus("Error", "error");
    showToast(error.message || "No se pudo actualizar la configuracion.", "error");
  } finally {
    settingsSaveBtn.disabled = false;
  }
};

const loadMenu = async () => {
  try {
    menuItems = await apiFetch(ADMIN_MENU_PATH);
    renderMenu();
  } catch (error) {
    showToast(error.message || "No se pudo cargar el menu.", "error");
  }
};

const renderMenu = () => {
  const term = menuSearch.value.trim().toLowerCase();
  if (!term) {
    menuGroups.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "helper";
    empty.textContent = "Empieza a escribir para buscar en el menu.";
    menuGroups.appendChild(empty);
    return;
  }

  const filtered = menuItems.filter((item) => {
    const name = String(item.name || "").toLowerCase();
    const category = String(item.category || "").toLowerCase();
    return name.includes(term) || category.includes(term);
  });

  const groups = filtered.reduce((acc, item) => {
    const key = item.category || "Sin categoria";
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  const categories = Object.keys(groups).sort((a, b) => a.localeCompare(b));
  menuGroups.innerHTML = "";

  if (categories.length === 0) {
    const empty = document.createElement("p");
    empty.className = "helper";
    empty.textContent = "No hay articulos del menu que coincidan con tu busqueda.";
    menuGroups.appendChild(empty);
    return;
  }

  categories.forEach((category) => {
    const wrapper = document.createElement("div");
    wrapper.className = "menu-group";
    const heading = document.createElement("h3");
    heading.textContent = category;
    wrapper.appendChild(heading);

    groups[category]
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
      .forEach((item) => {
        wrapper.appendChild(buildMenuItemCard(item));
      });

    menuGroups.appendChild(wrapper);
  });
};

const buildMenuItemCard = (item) => {
  const card = document.createElement("div");
  card.className = "menu-item";

  const titleRow = document.createElement("div");
  titleRow.className = "menu-item__title";

  const nameField = document.createElement("div");
  nameField.className = "field";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Nombre";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = item.name || "";
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameInput);

  const categoryField = document.createElement("div");
  categoryField.className = "field";
  const categoryLabel = document.createElement("label");
  categoryLabel.textContent = "Categoria";
  const categoryInput = document.createElement("input");
  categoryInput.type = "text";
  categoryInput.value = item.category || "";
  categoryField.appendChild(categoryLabel);
  categoryField.appendChild(categoryInput);

  titleRow.appendChild(nameField);
  titleRow.appendChild(categoryField);

  const controls = document.createElement("div");
  controls.className = "menu-item__controls";

  const priceField = document.createElement("div");
  priceField.className = "field";
  const priceLabel = document.createElement("label");
  priceLabel.textContent = "Precio (centavos)";
  const priceInput = document.createElement("input");
  priceInput.type = "number";
  priceInput.min = "0";
  priceInput.step = "1";
  priceInput.value = item.price_cents ?? 0;
  priceField.appendChild(priceLabel);
  priceField.appendChild(priceInput);

  const badgeField = document.createElement("div");
  badgeField.className = "field";
  const badgeLabel = document.createElement("label");
  badgeLabel.textContent = "Etiqueta";
  const badgeInput = document.createElement("input");
  badgeInput.type = "text";
  badgeInput.maxLength = 40;
  badgeInput.value = item.badge || "";
  badgeField.appendChild(badgeLabel);
  badgeField.appendChild(badgeInput);

  const sortField = document.createElement("div");
  sortField.className = "field";
  const sortLabel = document.createElement("label");
  sortLabel.textContent = "Orden";
  const sortInput = document.createElement("input");
  sortInput.type = "number";
  sortInput.step = "1";
  sortInput.value = item.sort_order ?? 0;
  sortField.appendChild(sortLabel);
  sortField.appendChild(sortInput);

  const activeField = document.createElement("div");
  activeField.className = "field field--inline";
  const activeLabel = document.createElement("label");
  activeLabel.textContent = "Activo";
  const activeInput = document.createElement("input");
  activeInput.type = "checkbox";
  activeInput.checked = Boolean(item.is_active);
  activeField.appendChild(activeLabel);
  activeField.appendChild(activeInput);

  const stockField = document.createElement("div");
  stockField.className = "field field--inline";
  const stockLabel = document.createElement("label");
  stockLabel.textContent = "En inventario";
  const stockInput = document.createElement("input");
  stockInput.type = "checkbox";
  stockInput.checked = Boolean(item.in_stock);
  stockField.appendChild(stockLabel);
  stockField.appendChild(stockInput);

  controls.appendChild(priceField);
  controls.appendChild(badgeField);
  controls.appendChild(sortField);
  controls.appendChild(activeField);
  controls.appendChild(stockField);

  const actions = document.createElement("div");
  actions.className = "menu-item__actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn--small";
  saveBtn.textContent = "Guardar";
  actions.appendChild(saveBtn);

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const badgeValue = badgeInput.value.trim();
      const payload = {
        id: item.id,
        name: nameInput.value.trim(),
        category: categoryInput.value.trim(),
        price_cents: Number(priceInput.value || 0),
        badge: badgeValue.length ? badgeValue : null,
        sort_order: Number(sortInput.value || 0),
        is_active: activeInput.checked,
        in_stock: stockInput.checked,
      };
      const updated = await apiFetch(ADMIN_MENU_ITEM_PATH, { method: "PATCH", body: payload });
      menuItems = menuItems.map((row) => (row.id === updated.id ? updated : row));
      renderMenu();
      showToast("Articulo del menu actualizado.");
    } catch (error) {
      showToast(error.message || "No se pudo actualizar el articulo del menu.", "error");
    } finally {
      saveBtn.disabled = false;
    }
  });

  card.appendChild(titleRow);
  card.appendChild(controls);
  card.appendChild(actions);

  return card;
};

const loadOrders = async () => {
  try {
    orders = await apiFetch(ADMIN_ORDERS_PATH, { method: "POST" });
    renderOrders();
  } catch (error) {
    showToast(error.message || "No se pudieron cargar los pedidos.", "error");
  }
};

const scheduleOrdersRefresh = () => {
  if (ordersRefreshTimer) return;
  ordersRefreshTimer = setTimeout(() => {
    ordersRefreshTimer = null;
    loadOrders();
  }, 400);
};

const startRealtime = () => {
  if (!getToken()) return;
  const client = getSupabaseClient();
  if (!client) return;

  if (realtimeChannel) {
    client.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  realtimeChannel = client
    .channel(REALTIME_CHANNEL)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, (payload) => {
      scheduleOrdersRefresh();
      if (payload?.new?.status === "new") {
        newOrderSound.currentTime = 0;
        newOrderSound.play().catch(() => {
          console.log("Audio bloqueado hasta que el usuario interactue");
        });
      }
      showToast("Nuevo pedido recibido.");
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders" }, () => {
      scheduleOrdersRefresh();
    })
    .subscribe();
};

const stopRealtime = () => {
  if (!realtimeChannel) return;
  const client = getSupabaseClient();
  if (client) client.removeChannel(realtimeChannel);
  realtimeChannel = null;
};

const updateOrdersTableScroll = () => {
  if (!ordersTableWrapper || !ordersTable) return;
  const rows = Array.from(ordersBody.querySelectorAll("tr"));

  if (rows.length <= 10) {
    ordersTableWrapper.style.maxHeight = "";
    ordersTableWrapper.style.overflowY = "hidden";
    return;
  }

  const header = ordersTable.querySelector("thead");
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const rowsHeight = rows.slice(0, 10).reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
  const maxHeight = Math.ceil(headerHeight + rowsHeight);
  ordersTableWrapper.style.maxHeight = `${maxHeight}px`;
  ordersTableWrapper.style.overflowY = "auto";
};

const scheduleOrdersTableScroll = () => {
  if (!ordersTableWrapper) return;
  requestAnimationFrame(updateOrdersTableScroll);
};

const renderOrders = () => {
  ordersBody.innerHTML = "";
  const hasStatus = orders.some((order) => typeof order.status !== "undefined");
  ordersStatusHeader.hidden = !hasStatus;

  if (!orders.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = hasStatus ? 7 : 6;
    cell.textContent = "No hay pedidos recientes.";
    row.appendChild(cell);
    ordersBody.appendChild(row);
    scheduleOrdersTableScroll();
    return;
  }

  orders.forEach((order) => {
    const row = document.createElement("tr");
    row.dataset.id = order.id;
    row.innerHTML = `
      <td>#${order.id}</td>
      <td>${order.customer_name || "-"}</td>
      <td>${order.customer_phone || "-"}</td>
      <td>${formatFulfillmentType(order.fulfillment_type)}</td>
      <td>${formatMoney(order.total_cents)}</td>
      <td>${new Date(order.created_at).toLocaleString()}</td>
      ${hasStatus ? `<td>${order.status ?? "-"}</td>` : ""}
    `;
    row.addEventListener("click", () => {
      loadOrderDetail(order.id);
    });
    ordersBody.appendChild(row);
  });

  scheduleOrdersTableScroll();
};

const loadOrderDetail = async (id) => {
  try {
    const data = await apiFetch(`${ADMIN_ORDER_PATH}&id=${id}`);
    renderOrderDetail(data.order, data.items);
  } catch (error) {
    showToast(error.message || "No se pudo cargar el pedido.", "error");
  }
};

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
const sortItemsWithDrinksLast = (list = []) =>
  [...list].sort((a, b) => {
    const aDrink = isDrinkCategory(a?.category) || (!a?.category && isDrinkByName(a?.name || a?.item_name));
    const bDrink = isDrinkCategory(b?.category) || (!b?.category && isDrinkByName(b?.name || b?.item_name));
    if (aDrink === bDrink) return 0;
    return aDrink ? 1 : -1;
  });

const renderOrderDetail = (order, items) => {
  if (!orderDetail) return;
  const hasStatus = typeof order.status !== "undefined";
  const hasCloverOrderId = Boolean(order.clover_order_id);
  const sortedItems = sortItemsWithDrinksLast(Array.isArray(items) ? items : []);
  const itemsList = sortedItems
    .map((item) => `<li>${item.qty}x ${item.item_name} — ${formatMoney(item.line_total_cents)}</li>`)
    .join("");

  orderDetail.innerHTML = `
    <h3>Pedido #${order.id}</h3>
    <div class="grid grid--two">
      <div>
        <strong>Cliente:</strong> ${order.customer_name || "-"}<br />
        <strong>Telefono:</strong> ${order.customer_phone || "-"}<br />
        <strong>Tipo:</strong> ${formatFulfillmentType(order.fulfillment_type)}
      </div>
      <div>
        <strong>Subtotal:</strong> ${formatMoney(order.subtotal_cents)}<br />
        <strong>Cargo de procesamiento:</strong> ${formatMoney(order.processing_fee_cents)}<br />
        <strong>Cargo de entrega:</strong> ${formatMoney(order.delivery_fee_cents)}<br />
        <strong>Total:</strong> ${formatMoney(order.total_cents)}
      </div>
    </div>
    <div class="helper" style="margin-top:8px;">
      <strong>Direccion:</strong> ${order.delivery_address || "Recoger"}
    </div>
    ${
      hasCloverOrderId
        ? `<div class="helper" style="margin-top:8px;">
      <strong>ID de orden Clover:</strong> ${order.clover_order_id}
    </div>
    <div class="field" style="margin-top:12px;">
      <button class="btn btn--small" id="order-reprint" type="button">Reimprimir</button>
    </div>`
        : `<div class="helper" style="margin-top:8px;">
      Sin ID de orden Clover (no se envio al POS).
    </div>`
    }
    ${
      hasStatus
        ? `<div class="field" style="margin-top:12px;">
      <label for="order-status">Estado</label>
      <input id="order-status" type="text" value="${order.status ?? ""}" />
      <button class="btn btn--small" id="order-status-save" type="button">Actualizar estado</button>
    </div>`
        : ""
    }
    <div class="order-detail__items">
      <h4>Articulos</h4>
      <ul>${itemsList || "<li>No se encontraron articulos.</li>"}</ul>
    </div>
  `;

  if (hasStatus) {
    const statusInput = orderDetail.querySelector("#order-status");
    const statusBtn = orderDetail.querySelector("#order-status-save");
    statusBtn.addEventListener("click", async () => {
      statusBtn.disabled = true;
      try {
        const updated = await apiFetch(ADMIN_ORDER_PATH, {
          method: "PATCH",
          body: { id: order.id, status: statusInput.value.trim() },
        });
        showToast("Estado del pedido actualizado.");
        orders = orders.map((item) => (item.id === order.id ? { ...item, status: updated.status } : item));
        renderOrders();
      } catch (error) {
        showToast(error.message || "No se pudo actualizar el estado.", "error");
      } finally {
        statusBtn.disabled = false;
      }
    });
  }

  if (hasCloverOrderId) {
    const reprintBtn = orderDetail.querySelector("#order-reprint");
    reprintBtn.addEventListener("click", async () => {
      reprintBtn.disabled = true;
      try {
        await apiFetch(`${ADMIN_REPRINT_PATH}&id=${order.id}`, { method: "POST" });
        showToast("Reimpresion solicitada.");
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        reprintBtn.disabled = false;
      }
    });
  }
};

const getPromoCache = () => (Array.isArray(window.__promoCache) ? window.__promoCache : []);

const setPromoCache = (list) => {
  window.__promoCache = Array.isArray(list) ? list : [];
};

const clearPromoFeedback = () => {
  if (promoError) {
    promoError.hidden = true;
    promoError.textContent = "";
  }
  if (promoSuccess) {
    promoSuccess.hidden = true;
    promoSuccess.textContent = "";
  }
};

const showPromoError = (message) => {
  if (!promoError) return;
  promoError.textContent = message;
  promoError.hidden = false;
  if (promoSuccess) {
    promoSuccess.hidden = true;
    promoSuccess.textContent = "";
  }
};

const showPromoSuccess = (message) => {
  if (!promoSuccess) return;
  promoSuccess.textContent = message;
  promoSuccess.hidden = false;
  if (promoError) {
    promoError.hidden = true;
    promoError.textContent = "";
  }
};

const updatePromoValueHint = () => {
  if (!promoTypeSelect || !promoValueHint) return;
  promoValueHint.textContent =
    promoTypeSelect.value === "flat"
      ? "Ingresa dolares (ej.: 5 para descuento de $5)"
      : "Ingresa porcentaje (ej.: 10 para 10% de descuento)";
};

const renderPromoCodes = (list) => {
  if (!promoTableBody) return;
  const promoList = Array.isArray(list) ? list : [];

  if (promoList.length === 0) {
    promoTableBody.innerHTML = '<tr><td colspan="7">No se encontraron codigos promocionales.</td></tr>';
    return;
  }

  promoTableBody.innerHTML = promoList
    .map((promo) => {
      const code = normalizeCode(promo.code);
      const type = promo.discount_type === "percent" ? "Porcentaje" : "Fijo";
      const value =
        promo.discount_type === "flat"
          ? `$${centsToDollars(promo.discount_value)}`
          : `${Math.floor(Number(promo.discount_value || 0))}%`;
      const min = `$${centsToDollars(promo.min_order_cents)}`;
      const used = Math.max(0, Math.floor(Number(promo.used_count || 0)));
      const active = promo.active ? "Si" : "No";

      return `
        <tr>
          <td>${escapeHtml(code)}</td>
          <td>${escapeHtml(type)}</td>
          <td>${escapeHtml(value)}</td>
          <td>${escapeHtml(min)}</td>
          <td>${escapeHtml(String(used))}</td>
          <td>${escapeHtml(active)}</td>
          <td><button class="btn btn--ghost btn--small" type="button" data-promo-edit="${escapeHtml(code)}">Editar</button></td>
        </tr>
      `;
    })
    .join("");
};

const fillPromoForm = (promo) => {
  if (!promoForm || !promo) return;

  if (promoCodeInput) promoCodeInput.value = normalizeCode(promo.code);
  if (promoTypeSelect) promoTypeSelect.value = promo.discount_type === "percent" ? "percent" : "flat";
  if (promoValueInput) {
    promoValueInput.value =
      promo.discount_type === "flat"
        ? centsToDollars(promo.discount_value)
        : String(Math.floor(Number(promo.discount_value || 0)));
  }
  if (promoMinInput) promoMinInput.value = centsToDollars(promo.min_order_cents);
  if (promoActiveInput) promoActiveInput.checked = Boolean(promo.active);
  updatePromoValueHint();
  clearPromoFeedback();
};

const loadPromoCodes = async () => {
  if (!promoTableBody) return;
  try {
    const data = await adminFetch(ADMIN_PROMO_CODES_PATH);
    const list = Array.isArray(data?.promo_codes) ? data.promo_codes : [];
    setPromoCache(list);
    renderPromoCodes(list);
  } catch (error) {
    setPromoCache([]);
    renderPromoCodes([]);
    showToast(error.message || "No se pudieron cargar los codigos promocionales.", "error");
  }
};

const refreshPromoCodes = async () => {
  await loadPromoCodes();
};

const savePromoCode = async (event) => {
  event.preventDefault();
  clearPromoFeedback();

  const code = normalizeCode(promoCodeInput?.value);
  const discountType = promoTypeSelect?.value === "percent" ? "percent" : "flat";
  const valueInput = Number(promoValueInput?.value);
  const minInput = Number(promoMinInput?.value || 0);

  if (!code) {
    showPromoError("El codigo es obligatorio.");
    return;
  }
  if (!Number.isFinite(valueInput) || valueInput <= 0) {
    showPromoError("El valor debe ser mayor que 0.");
    return;
  }
  if (!Number.isFinite(minInput) || minInput < 0) {
    showPromoError("El pedido minimo debe ser 0 o mayor.");
    return;
  }

  const payload = {
    code,
    discount_type: discountType,
    discount_value: discountType === "flat" ? dollarsToCents(valueInput) : Math.floor(valueInput),
    min_order_cents: dollarsToCents(minInput),
    active: Boolean(promoActiveInput?.checked),
  };

  if (payload.discount_value <= 0) {
    showPromoError("El valor del descuento debe ser mayor que 0.");
    return;
  }

  const submitBtn = promoForm?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const data = await adminFetch(ADMIN_PROMO_CODE_PATH, { method: "POST", body: payload });
    await refreshPromoCodes();

    if (data?.promo_code) {
      fillPromoForm(data.promo_code);
    }
    showPromoSuccess(`Se guardo ${data?.promo_code?.code || code}.`);
  } catch (error) {
    showPromoError(error.message || "No se pudo guardar el codigo promocional.");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
};

const handlePromoEditClick = (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("[data-promo-edit]");
  if (!button) return;

  const code = normalizeCode(button.getAttribute("data-promo-edit"));
  const promo = getPromoCache().find((row) => normalizeCode(row?.code) === code);
  if (!promo) {
    showToast("No se encontro el codigo promocional.", "error");
    return;
  }

  fillPromoForm(promo);
  showPromoSuccess(`Editando ${promo.code}. Actualiza los campos y guarda.`);
};

const initialize = async () => {
  const token = getToken();
  setAuthState(false);
  updatePromoValueHint();

  if (token) {
    try {
      await validateToken(token);
      setAuthState(true);
      await Promise.all([loadSettings(), loadMenu(), loadOrders(), refreshPromoCodes()]);
      startRealtime();
    } catch (error) {
      sessionStorage.removeItem(TOKEN_KEY);
      setAuthState(false);
      showToast(error.message || "Token invalido", "error");
    }
  }
};

loginBtn.addEventListener("click", async () => {
  loginBtn.disabled = true;
  const token = tokenInput.value.trim();
  if (!token) {
    showToast("Ingresa tu token de administrador.", "error");
    loginBtn.disabled = false;
    return;
  }

  try {
    await validateToken(token);
    sessionStorage.setItem(TOKEN_KEY, token);
    setAuthState(true);
    await Promise.all([loadSettings(), loadMenu(), loadOrders(), refreshPromoCodes()]);
    startRealtime();
    showToast("Bienvenido de nuevo.");
    tokenInput.value = "";
  } catch (error) {
    sessionStorage.removeItem(TOKEN_KEY);
    setAuthState(false);
    showToast(error.message || "Token invalido", "error");
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem(TOKEN_KEY);
  setAuthState(false);
  stopRealtime();
  setPromoCache([]);
  renderPromoCodes([]);
  clearPromoFeedback();
  showToast("Sesion cerrada.");
});

menuSearch.addEventListener("input", renderMenu);
settingsForm.addEventListener("submit", saveSettings);
ordersRefreshBtn.addEventListener("click", loadOrders);
if (promoTypeSelect) promoTypeSelect.addEventListener("change", updatePromoValueHint);
if (promoForm) promoForm.addEventListener("submit", savePromoCode);
document.addEventListener("click", handlePromoEditClick);
window.addEventListener("resize", scheduleOrdersTableScroll);

initialize();
