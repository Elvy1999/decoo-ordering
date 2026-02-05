const supabaseLib = window.supabase;
const createClient = supabaseLib?.createClient;

if (!createClient) {
  console.error(
    "Supabase UMD bundle not available. Ensure https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js is loaded before admin.js.",
  );
}

const TOKEN_KEY = "ADMIN_TOKEN";
const REALTIME_CHANNEL = "admin-orders";

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

let menuItems = [];
let orders = [];
let supabaseClient = null;
let realtimeChannel = null;
let ordersRefreshTimer = null;

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
    console.warn("Supabase client unavailable; realtime disabled.");
    return null;
  }
  if (supabaseClient) return supabaseClient;
  const url = window.PUBLIC_SUPABASE_URL;
  const anonKey = window.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.warn("Supabase public credentials are missing; realtime disabled.");
    return null;
  }
  supabaseClient = createClient(url, anonKey);
  return supabaseClient;
};

const handleUnauthorized = () => {
  sessionStorage.removeItem(TOKEN_KEY);
  setAuthState(false);
  stopRealtime();
  showToast("Session expired. Please log in again.", "error");
};

const apiFetch = async (path, { method = "GET", body } = {}) => {
  const headers = {};
  const token = getToken();
  if (token) headers["x-admin-token"] = token;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(path, { method, headers, body: payload });
  if (response.status === 401) {
    handleUnauthorized();
    throw new Error("Unauthorized");
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.error?.message || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
};

const validateToken = async (token) => {
  if (!token) throw new Error("Invalid token");
  const response = await fetch("/api/admin?route=settings", {
    method: "GET",
    headers: { "x-admin-token": token },
  });
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Unauthorized" : "Invalid token");
  }
  return true;
};

const formatMoney = (cents) => {
  const value = Number(cents) / 100;
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
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
  setSettingsStatus("Loading...");
  try {
    const settings = await apiFetch("/api/admin?route=settings");
    fillSettingsForm(settings);
    setSettingsStatus("Loaded");
  } catch (error) {
    setSettingsStatus("Error", "error");
    showToast(error.message || "Could not load settings.", "error");
  }
};

const saveSettings = async (event) => {
  event.preventDefault();
  settingsSaveBtn.disabled = true;
  setSettingsStatus("Saving...");
  try {
    const payload = {
      ordering_enabled: settingsForm.ordering_enabled.checked,
      delivery_enabled: settingsForm.delivery_enabled.checked,
      delivery_radius_miles: Number(settingsForm.delivery_radius_miles.value || 0),
      processing_fee_cents: Number(settingsForm.processing_fee_cents.value || 0),
      delivery_fee_cents: Number(settingsForm.delivery_fee_cents.value || 0),
      delivery_min_total_cents: Number(settingsForm.delivery_min_total_cents.value || 0),
    };
    const updated = await apiFetch("/api/admin?route=settings", { method: "PATCH", body: payload });
    fillSettingsForm(updated);
    setSettingsStatus("Saved");
    showToast("Settings updated.");
  } catch (error) {
    setSettingsStatus("Error", "error");
    showToast(error.message || "Failed to update settings.", "error");
  } finally {
    settingsSaveBtn.disabled = false;
  }
};

const loadMenu = async () => {
  try {
    menuItems = await apiFetch("/api/admin?route=menu");
    renderMenu();
  } catch (error) {
    showToast(error.message || "Failed to load menu.", "error");
  }
};

const renderMenu = () => {
  const term = menuSearch.value.trim().toLowerCase();
  if (!term) {
    menuGroups.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "helper";
    empty.textContent = "Start typing to search the menu.";
    menuGroups.appendChild(empty);
    return;
  }

  const filtered = menuItems.filter((item) => {
    const name = String(item.name || "").toLowerCase();
    const category = String(item.category || "").toLowerCase();
    return name.includes(term) || category.includes(term);
  });

  const groups = filtered.reduce((acc, item) => {
    const key = item.category || "Uncategorized";
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  const categories = Object.keys(groups).sort((a, b) => a.localeCompare(b));
  menuGroups.innerHTML = "";

  if (categories.length === 0) {
    const empty = document.createElement("p");
    empty.className = "helper";
    empty.textContent = "No menu items match your search.";
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
  nameLabel.textContent = "Name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = item.name || "";
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameInput);

  const categoryField = document.createElement("div");
  categoryField.className = "field";
  const categoryLabel = document.createElement("label");
  categoryLabel.textContent = "Category";
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
  priceLabel.textContent = "Price (cents)";
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
  badgeLabel.textContent = "Badge";
  const badgeInput = document.createElement("input");
  badgeInput.type = "text";
  badgeInput.maxLength = 40;
  badgeInput.value = item.badge || "";
  badgeField.appendChild(badgeLabel);
  badgeField.appendChild(badgeInput);

  const sortField = document.createElement("div");
  sortField.className = "field";
  const sortLabel = document.createElement("label");
  sortLabel.textContent = "Sort Order";
  const sortInput = document.createElement("input");
  sortInput.type = "number";
  sortInput.step = "1";
  sortInput.value = item.sort_order ?? 0;
  sortField.appendChild(sortLabel);
  sortField.appendChild(sortInput);

  const activeField = document.createElement("div");
  activeField.className = "field field--inline";
  const activeLabel = document.createElement("label");
  activeLabel.textContent = "Active";
  const activeInput = document.createElement("input");
  activeInput.type = "checkbox";
  activeInput.checked = Boolean(item.is_active);
  activeField.appendChild(activeLabel);
  activeField.appendChild(activeInput);

  const stockField = document.createElement("div");
  stockField.className = "field field--inline";
  const stockLabel = document.createElement("label");
  stockLabel.textContent = "In Stock";
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
  saveBtn.textContent = "Save";
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
      const updated = await apiFetch("/api/admin?route=menu-item", { method: "PATCH", body: payload });
      menuItems = menuItems.map((row) => (row.id === updated.id ? updated : row));
      renderMenu();
      showToast("Menu item updated.");
    } catch (error) {
      showToast(error.message || "Failed to update menu item.", "error");
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
    orders = await apiFetch("/api/admin?route=orders");
    renderOrders();
  } catch (error) {
    showToast(error.message || "Failed to load orders.", "error");
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
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "orders" },
      (payload) => {
        scheduleOrdersRefresh();
        if (payload?.new?.status === "new") {
          newOrderSound.currentTime = 0;
          newOrderSound.play().catch(() => {
            console.log("Audio blocked until user interaction");
          });
        }
        showToast("New order received.");
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "orders" },
      () => {
        scheduleOrdersRefresh();
      },
    )
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
    cell.textContent = "No recent orders.";
    row.appendChild(cell);
    ordersBody.appendChild(row);
    scheduleOrdersTableScroll();
    return;
  }

  orders.forEach((order) => {
    const row = document.createElement("tr");
    row.dataset.id = order.id;
    row.innerHTML = `
      <td>${order.order_code || order.id}</td>
      <td>${order.customer_name || "-"}</td>
      <td>${order.customer_phone || "-"}</td>
      <td>${order.fulfillment_type || "-"}</td>
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
    const data = await apiFetch(`/api/admin?route=order&id=${id}`);
    renderOrderDetail(data.order, data.items);
  } catch (error) {
    showToast(error.message || "Failed to load order.", "error");
  }
};

const renderOrderDetail = (order, items) => {
  if (!orderDetail) return;
  const hasStatus = typeof order.status !== "undefined";
  const itemsList = items
    .map(
      (item) =>
        `<li>${item.qty}x ${item.item_name} — ${formatMoney(item.line_total_cents)}</li>`,
    )
    .join("");

  orderDetail.innerHTML = `
    <h3>Order ${order.order_code || order.id}</h3>
    <div class="grid grid--two">
      <div>
        <strong>Customer:</strong> ${order.customer_name || "-"}<br />
        <strong>Phone:</strong> ${order.customer_phone || "-"}<br />
        <strong>Type:</strong> ${order.fulfillment_type || "-"}
      </div>
      <div>
        <strong>Subtotal:</strong> ${formatMoney(order.subtotal_cents)}<br />
        <strong>Processing Fee:</strong> ${formatMoney(order.processing_fee_cents)}<br />
        <strong>Delivery Fee:</strong> ${formatMoney(order.delivery_fee_cents)}<br />
        <strong>Total:</strong> ${formatMoney(order.total_cents)}
      </div>
    </div>
    <div class="helper" style="margin-top:8px;">
      <strong>Address:</strong> ${order.delivery_address || "Pickup"}
    </div>
    ${hasStatus ? `<div class="field" style="margin-top:12px;">
      <label for="order-status">Status</label>
      <input id="order-status" type="text" value="${order.status ?? ""}" />
      <button class="btn btn--small" id="order-status-save" type="button">Update Status</button>
    </div>` : ""}
    <div class="order-detail__items">
      <h4>Items</h4>
      <ul>${itemsList || "<li>No items found.</li>"}</ul>
    </div>
  `;

  if (hasStatus) {
    const statusInput = orderDetail.querySelector("#order-status");
    const statusBtn = orderDetail.querySelector("#order-status-save");
    statusBtn.addEventListener("click", async () => {
      statusBtn.disabled = true;
      try {
        const updated = await apiFetch("/api/admin?route=order", {
          method: "PATCH",
          body: { id: order.id, status: statusInput.value.trim() },
        });
        showToast("Order status updated.");
        orders = orders.map((item) => (item.id === order.id ? { ...item, status: updated.status } : item));
        renderOrders();
      } catch (error) {
        showToast(error.message || "Failed to update status.", "error");
      } finally {
        statusBtn.disabled = false;
      }
    });
  }
};

const initialize = async () => {
  const token = getToken();
  setAuthState(false);

  if (token) {
    try {
      await validateToken(token);
      setAuthState(true);
      await Promise.all([loadSettings(), loadMenu(), loadOrders()]);
      startRealtime();
    } catch (error) {
      sessionStorage.removeItem(TOKEN_KEY);
      setAuthState(false);
      showToast("Invalid token", "error");
    }
  }
};

loginBtn.addEventListener("click", async () => {
  loginBtn.disabled = true;
  const token = tokenInput.value.trim();
  if (!token) {
    showToast("Please enter your admin token.", "error");
    loginBtn.disabled = false;
    return;
  }

  try {
    await validateToken(token);
    sessionStorage.setItem(TOKEN_KEY, token);
    setAuthState(true);
    await Promise.all([loadSettings(), loadMenu(), loadOrders()]);
    startRealtime();
    showToast("Welcome back.");
    tokenInput.value = "";
  } catch (error) {
    sessionStorage.removeItem(TOKEN_KEY);
    setAuthState(false);
    showToast("Invalid token", "error");
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem(TOKEN_KEY);
  setAuthState(false);
  stopRealtime();
  showToast("Logged out.");
});

menuSearch.addEventListener("input", renderMenu);
settingsForm.addEventListener("submit", saveSettings);
ordersRefreshBtn.addEventListener("click", loadOrders);
window.addEventListener("resize", scheduleOrdersTableScroll);

initialize();
