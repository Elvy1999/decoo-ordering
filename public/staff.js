const TOKEN_KEY = "STAFF_TOKEN"
const STAFF_ORDERS_PATH = "/api/staff/orders"
const POLL_INTERVAL_MS = 12000
const REALTIME_CHANNEL = "staff-orders-live"

const loginPanel = document.getElementById("login-panel")
const staffApp = document.getElementById("staff-app")
const loginForm = document.getElementById("login-form")
const loginBtn = document.getElementById("login-btn")
const logoutBtn = document.getElementById("logout-btn")
const tokenInput = document.getElementById("staff-token-input")
const refreshBtn = document.getElementById("refresh-btn")
const ordersListEl = document.getElementById("orders-list")
const detailsPanelEl = document.getElementById("details-panel")
const toastEl = document.getElementById("toast")

const supabaseLib = window.supabase
const createClient = supabaseLib?.createClient

const orderSound = new Audio("/order_sound.mp3")
orderSound.volume = 0.7

let orders = []
let selectedOrderId = null
let updatingOrderIds = new Set()
let knownPaidOrderIds = new Set()
let hasHydratedOrders = false
let pollTimer = null
let refreshDebounceTimer = null
let supabaseClient = null
let realtimeChannel = null

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#39;"
  })

const showToast = (message, type = "success") => {
  if (!toastEl) return
  toastEl.textContent = message
  toastEl.className = `toast show toast--${type}`
  clearTimeout(showToast._timer)
  showToast._timer = setTimeout(() => {
    toastEl.className = "toast"
  }, 2400)
}

const setAuthState = (isAuthed) => {
  if (loginPanel) loginPanel.hidden = isAuthed
  if (staffApp) staffApp.hidden = !isAuthed
  if (logoutBtn) logoutBtn.style.display = isAuthed ? "inline-flex" : "none"
}

const getToken = () => localStorage.getItem(TOKEN_KEY) || ""

const parseErrorMessage = (payload, fallback, status) => {
  if (typeof payload?.error === "string") return payload.error
  if (typeof payload?.error?.message === "string") return payload.error.message
  if (typeof payload?.message === "string") return payload.message
  if (status === 401) return "Unauthorized"
  return fallback
}

const apiFetch = async (path, { method = "GET", body, token, suppressUnauthorizedHandler = false } = {}) => {
  const headers = { Accept: "application/json" }
  const authToken = token ?? getToken()
  if (authToken) headers.Authorization = `Bearer ${authToken}`

  let payload
  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
    payload = JSON.stringify(body)
  }

  const response = await fetch(path, { method, headers, body: payload })
  const raw = await response.text()

  let data = null
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = null
    }
  }

  if (response.status === 401) {
    if (!suppressUnauthorizedHandler) handleUnauthorized()
    const unauthorizedError = new Error("Unauthorized")
    unauthorizedError.status = 401
    throw unauthorizedError
  }

  if (!response.ok) {
    const error = new Error(parseErrorMessage(data, `Request failed (${response.status})`, response.status))
    error.status = response.status
    throw error
  }

  return data
}

const validateToken = async (token) => {
  if (!token) {
    const error = new Error("Unauthorized")
    error.status = 401
    throw error
  }
  await apiFetch(STAFF_ORDERS_PATH, { token, suppressUnauthorizedHandler: true })
}

const formatMoney = (cents) => {
  const amount = Number(cents) / 100
  if (!Number.isFinite(amount)) return "$0.00"
  return `$${amount.toFixed(2)}`
}

const formatDateTime = (value) => {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

const formatFulfillmentType = (value) => {
  if (value === "pickup") return "Pickup"
  if (value === "delivery") return "Delivery"
  return value || "-"
}

const isPaidOrder = (order) => order?.payment_status === "paid" || Boolean(order?.paid_at)
const isCompletedOrder = (order) => String(order?.status || "").toLowerCase() === "completed"
const getOrderTimeValue = (order) => order?.paid_at || order?.created_at || null

const findSelectedOrder = () => orders.find((order) => String(order.id) === String(selectedOrderId)) || null

const renderOrders = () => {
  if (!ordersListEl) return
  ordersListEl.innerHTML = ""

  if (!orders.length) {
    const empty = document.createElement("div")
    empty.className = "empty-state"
    empty.textContent = "No paid orders yet."
    ordersListEl.appendChild(empty)
    return
  }

  orders.forEach((order) => {
    const idKey = String(order.id)
    const completed = isCompletedOrder(order)
    const row = document.createElement("article")
    row.className = `order-row${idKey === String(selectedOrderId) ? " is-selected" : ""}`

    const left = document.createElement("div")
    left.innerHTML = `
      <div class="order-code">${escapeHtml(order.order_code || order.id)}</div>
      <div class="order-meta">${escapeHtml(order.customer_name || "-")}</div>
      <div class="order-meta">${escapeHtml(order.customer_phone || "-")}</div>
    `

    const middle = document.createElement("div")
    middle.innerHTML = `
      <div class="order-type"><strong>${formatFulfillmentType(order.fulfillment_type)}</strong></div>
      <div class="order-type">${escapeHtml(formatDateTime(getOrderTimeValue(order)))}</div>
    `

    const right = document.createElement("div")
    right.className = "order-right"

    const pill = document.createElement("span")
    pill.className = `pill ${completed ? "pill--done" : "pill--open"}`
    pill.textContent = completed ? "Completed" : "Open"

    const toggleBtn = document.createElement("button")
    toggleBtn.type = "button"
    toggleBtn.className = `order-toggle${completed ? " done" : ""}`
    toggleBtn.disabled = updatingOrderIds.has(idKey)
    toggleBtn.textContent = completed ? "Mark Open" : "Mark Complete"
    toggleBtn.addEventListener("click", (event) => {
      event.stopPropagation()
      void updateCompletion(order, !completed)
    })

    right.appendChild(pill)
    right.appendChild(toggleBtn)

    row.appendChild(left)
    row.appendChild(middle)
    row.appendChild(right)

    row.addEventListener("click", () => {
      selectedOrderId = idKey
      renderOrders()
      renderDetails()
    })

    ordersListEl.appendChild(row)
  })
}

const renderDetails = () => {
  if (!detailsPanelEl) return
  const order = findSelectedOrder()

  if (!order) {
    detailsPanelEl.innerHTML = `
      <h3>Order Details</h3>
      <p class="helper">Select an order to view details.</p>
    `
    return
  }

  const items = Array.isArray(order.items) ? order.items : []
  const itemsMarkup =
    items.length > 0
      ? items
          .map((item) => {
            const qty = Number(item?.qty || 0)
            const lineTotal = Number.isFinite(Number(item?.line_total_cents))
              ? Number(item?.line_total_cents)
              : Number(item?.unit_price_cents || 0) * qty
            return `<li><span>${escapeHtml(item?.item_name || "Item")} x ${qty}</span><strong>${formatMoney(lineTotal)}</strong></li>`
          })
          .join("")
      : "<li><span>No items</span><strong>-</strong></li>"

  const deliveryAddress =
    order.fulfillment_type === "delivery" && order.delivery_address
      ? `<div class="details-block"><strong>Delivery address:</strong> ${escapeHtml(order.delivery_address)}</div>`
      : ""

  const notes = String(order.notes || "").trim()
  const notesMarkup = notes
    ? `<div class="details-block"><strong>Notes</strong><div class="note">${escapeHtml(notes)}</div></div>`
    : ""
  const discountCents = Number(order.discount_cents || 0)
  const discountLabel = discountCents > 0 ? `-${formatMoney(discountCents)}` : formatMoney(discountCents)

  detailsPanelEl.innerHTML = `
    <h3>Order ${escapeHtml(order.order_code || order.id)}</h3>
    <p class="helper">Paid time: ${escapeHtml(formatDateTime(getOrderTimeValue(order)))}</p>

    <div class="details-block">
      <div class="details-grid">
        <div><span>Customer</span><br /><strong>${escapeHtml(order.customer_name || "-")}</strong></div>
        <div><span>Phone</span><br /><strong>${escapeHtml(order.customer_phone || "-")}</strong></div>
        <div><span>Type</span><br /><strong>${escapeHtml(formatFulfillmentType(order.fulfillment_type))}</strong></div>
        <div><span>Status</span><br /><strong>${isCompletedOrder(order) ? "Completed" : "Open"}</strong></div>
      </div>
    </div>

    ${deliveryAddress}

    <div class="details-block">
      <strong>Items</strong>
      <ul class="items-list">${itemsMarkup}</ul>
    </div>

    <div class="details-block">
      <strong>Totals</strong>
      <div class="totals">
        <div class="totals-row"><span>Subtotal</span><strong>${formatMoney(order.subtotal_cents)}</strong></div>
        <div class="totals-row"><span>Processing fee</span><strong>${formatMoney(order.processing_fee_cents)}</strong></div>
        <div class="totals-row"><span>Delivery fee</span><strong>${formatMoney(order.delivery_fee_cents)}</strong></div>
        <div class="totals-row"><span>Discount</span><strong>${discountLabel}</strong></div>
        <div class="totals-row total"><span>Total</span><strong>${formatMoney(order.total_cents)}</strong></div>
      </div>
    </div>

    ${notesMarkup}
  `
}

const playOrderSound = () => {
  orderSound.currentTime = 0
  orderSound.play().catch(() => {})
}

const applyOrders = (nextOrders) => {
  const paidOrders = (Array.isArray(nextOrders) ? nextOrders : []).filter(isPaidOrder)
  const nextKnown = new Set(paidOrders.map((order) => String(order.id)))
  let newPaidCount = 0

  if (hasHydratedOrders) {
    nextKnown.forEach((id) => {
      if (!knownPaidOrderIds.has(id)) newPaidCount += 1
    })
  }

  orders = paidOrders
  knownPaidOrderIds = nextKnown

  if (!selectedOrderId && orders.length) {
    selectedOrderId = String(orders[0].id)
  } else if (selectedOrderId && !orders.some((order) => String(order.id) === String(selectedOrderId))) {
    selectedOrderId = orders.length ? String(orders[0].id) : null
  }

  renderOrders()
  renderDetails()

  if (hasHydratedOrders && newPaidCount > 0) {
    playOrderSound()
    showToast(newPaidCount > 1 ? "New paid orders" : "New paid order")
  }

  hasHydratedOrders = true
}

const loadOrders = async ({ silent = false } = {}) => {
  try {
    const data = await apiFetch(STAFF_ORDERS_PATH)
    applyOrders(data)
  } catch (error) {
    if (!silent) showToast(error.message || "Failed to load orders", "error")
  }
}

const updateCompletion = async (order, completed) => {
  const idKey = String(order.id)
  if (updatingOrderIds.has(idKey)) return

  updatingOrderIds.add(idKey)
  renderOrders()

  try {
    const updated = await apiFetch(`/api/staff/orders/${encodeURIComponent(order.id)}/complete`, {
      method: "POST",
      body: { completed },
    })
    const nextStatus = typeof updated?.status === "string" ? updated.status : completed ? "completed" : "paid"
    orders = orders.map((row) => (String(row.id) === idKey ? { ...row, status: nextStatus } : row))
    showToast(completed ? "Marked completed" : "Marked open")
  } catch (error) {
    showToast(error?.status === 401 ? "Unauthorized" : "Failed to update", "error")
  } finally {
    updatingOrderIds.delete(idKey)
    renderOrders()
    renderDetails()
  }
}

const getSupabaseClient = () => {
  if (!createClient) return null
  if (supabaseClient) return supabaseClient

  const url = window.PUBLIC_SUPABASE_URL
  const anonKey = window.PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null

  supabaseClient = createClient(url, anonKey)
  return supabaseClient
}

const scheduleOrdersRefresh = () => {
  if (refreshDebounceTimer) return
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null
    void loadOrders({ silent: true })
  }, 350)
}

const startRealtime = () => {
  const client = getSupabaseClient()
  if (!client) return

  if (realtimeChannel) {
    client.removeChannel(realtimeChannel)
    realtimeChannel = null
  }

  realtimeChannel = client
    .channel(REALTIME_CHANNEL)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, (payload) => {
      if (isPaidOrder(payload?.new)) scheduleOrdersRefresh()
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders" }, (payload) => {
      if (isPaidOrder(payload?.new) || isPaidOrder(payload?.old)) scheduleOrdersRefresh()
    })
    .subscribe()
}

const stopRealtime = () => {
  if (!realtimeChannel) return
  const client = getSupabaseClient()
  if (client) client.removeChannel(realtimeChannel)
  realtimeChannel = null
}

const startPolling = () => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    void loadOrders({ silent: true })
  }, POLL_INTERVAL_MS)
}

const stopLiveUpdates = () => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer)
    refreshDebounceTimer = null
  }
  stopRealtime()
}

const resetOrdersState = () => {
  orders = []
  selectedOrderId = null
  updatingOrderIds = new Set()
  knownPaidOrderIds = new Set()
  hasHydratedOrders = false
  renderOrders()
  renderDetails()
}

const handleUnauthorized = () => {
  localStorage.removeItem(TOKEN_KEY)
  stopLiveUpdates()
  setAuthState(false)
  resetOrdersState()
  showToast("Unauthorized", "error")
}

const startAuthedSession = async (token, { showWelcome = false } = {}) => {
  await validateToken(token)
  localStorage.setItem(TOKEN_KEY, token)
  setAuthState(true)
  await loadOrders()
  startRealtime()
  startPolling()
  if (showWelcome) showToast("Signed in")
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault()
  if (!loginBtn || !tokenInput) return

  const token = tokenInput.value.trim()
  if (!token) {
    showToast("Enter your staff token", "error")
    return
  }

  loginBtn.disabled = true
  try {
    await startAuthedSession(token, { showWelcome: true })
    tokenInput.value = ""
  } catch (error) {
    localStorage.removeItem(TOKEN_KEY)
    setAuthState(false)
    resetOrdersState()
    showToast(error?.status === 401 ? "Unauthorized" : error.message || "Login failed", "error")
  } finally {
    loginBtn.disabled = false
  }
})

logoutBtn?.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY)
  stopLiveUpdates()
  setAuthState(false)
  resetOrdersState()
  showToast("Signed out")
})

refreshBtn?.addEventListener("click", () => {
  void loadOrders()
})

const initialize = async () => {
  setAuthState(false)
  resetOrdersState()

  const token = getToken()
  if (!token) return

  try {
    await startAuthedSession(token)
  } catch (error) {
    localStorage.removeItem(TOKEN_KEY)
    setAuthState(false)
    resetOrdersState()
    showToast(error?.status === 401 ? "Unauthorized" : "Session expired", "error")
  }
}

initialize()
