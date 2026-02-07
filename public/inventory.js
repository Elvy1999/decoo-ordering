const TOKEN_KEY = "STAFF_TOKEN"
const INVENTORY_SECTIONS_PATH = "/api/staff/inventory/sections"

const loginPanel = document.getElementById("login-panel")
const inventoryApp = document.getElementById("inventory-app")
const loginForm = document.getElementById("login-form")
const loginBtn = document.getElementById("login-btn")
const logoutBtn = document.getElementById("logout-btn")
const tokenInput = document.getElementById("staff-token-input")
const categoriesEl = document.getElementById("categories")
const modalEl = document.getElementById("category-modal")
const modalTitleEl = document.getElementById("modal-title")
const modalBodyEl = document.getElementById("modal-body")
const modalCloseBtn = document.getElementById("modal-close")
const toastEl = document.getElementById("toast")

let sections = []
let activeCategoryIndex = -1
let updatingItemIds = new Set()

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
  if (inventoryApp) inventoryApp.hidden = !isAuthed
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

const normalizeApiPath = (path) => {
  const raw = String(path || "").trim()
  if (!raw) return "/"

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw, window.location.origin)
    if (/decoorestaurant\.com$/i.test(url.hostname)) {
      return `${url.pathname}${url.search}`
    }
    if (url.origin !== window.location.origin) {
      throw new Error("Cross-origin API calls are not allowed.")
    }
    return `${url.pathname}${url.search}`
  }

  const cleaned = raw.replace(/^\.\/+/, "")
  if (cleaned.startsWith("api/")) return `/${cleaned}`
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`
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

  const response = await fetch(normalizeApiPath(path), { method, headers, body: payload })
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
  await apiFetch(INVENTORY_SECTIONS_PATH, { token, suppressUnauthorizedHandler: true })
}

const formatMoney = (cents) => {
  const amount = Number(cents) / 100
  if (!Number.isFinite(amount)) return "$0.00"
  return `$${amount.toFixed(2)}`
}

const closeModal = () => {
  if (!modalEl) return
  modalEl.classList.remove("is-open", "modal--scrollable", "modal--scroll-end")
  modalEl.setAttribute("aria-hidden", "true")
  document.body.style.overflow = ""
  activeCategoryIndex = -1
}

const updateModalScrollIndicator = () => {
  if (!modalEl || !modalBodyEl) return
  const threshold = 12
  const hasOverflow = modalBodyEl.scrollHeight - modalBodyEl.clientHeight > threshold
  const atBottom = !hasOverflow || modalBodyEl.scrollTop + modalBodyEl.clientHeight >= modalBodyEl.scrollHeight - threshold
  modalEl.classList.toggle("modal--scrollable", hasOverflow)
  modalEl.classList.toggle("modal--scroll-end", atBottom)
}

const renderModal = () => {
  if (!modalBodyEl || !modalTitleEl) return
  const section = sections[activeCategoryIndex]
  if (!section) return

  modalTitleEl.textContent = section.category
  modalBodyEl.innerHTML = ""

  if (!Array.isArray(section.items) || section.items.length === 0) {
    const empty = document.createElement("div")
    empty.className = "empty-state"
    empty.textContent = "No items in this category."
    modalBodyEl.appendChild(empty)
    updateModalScrollIndicator()
    return
  }

  section.items.forEach((item) => {
    const itemId = String(item.id)
    const inStock = Boolean(item.in_stock)
    const wrapper = document.createElement("div")
    wrapper.className = "inventory-item"

    const left = document.createElement("div")
    left.innerHTML = `
      <div class="inventory-item__name">${escapeHtml(item.name || "Item")}</div>
      <div class="inventory-item__meta">${escapeHtml(formatMoney(item.price_cents))}${item.badge ? ` - ${escapeHtml(item.badge)}` : ""}</div>
    `

    const right = document.createElement("div")
    right.className = "inventory-item__right"

    const stockPill = document.createElement("span")
    stockPill.className = `stock-pill ${inStock ? "stock-pill--in" : "stock-pill--out"}`
    stockPill.textContent = inStock ? "In stock" : "Out"

    const toggleBtn = document.createElement("button")
    toggleBtn.type = "button"
    toggleBtn.className = `toggle-btn${inStock ? "" : " mark-in"}`
    toggleBtn.disabled = updatingItemIds.has(itemId)
    toggleBtn.textContent = inStock ? "Mark Out" : "Mark In"
    toggleBtn.addEventListener("click", () => {
      void toggleInventory(item.id, !inStock)
    })

    right.appendChild(stockPill)
    right.appendChild(toggleBtn)
    wrapper.appendChild(left)
    wrapper.appendChild(right)
    modalBodyEl.appendChild(wrapper)
  })

  updateModalScrollIndicator()
}

const openModalForCategory = (index) => {
  const section = sections[index]
  if (!section || !modalEl) return
  activeCategoryIndex = index
  modalEl.classList.add("is-open")
  modalEl.setAttribute("aria-hidden", "false")
  document.body.style.overflow = "hidden"
  renderModal()
}

const renderCategories = () => {
  if (!categoriesEl) return
  categoriesEl.innerHTML = ""

  if (!sections.length) {
    const empty = document.createElement("div")
    empty.className = "empty-state"
    empty.textContent = "No active categories found."
    categoriesEl.appendChild(empty)
    return
  }

  sections.forEach((section, index) => {
    const totalItems = Array.isArray(section.items) ? section.items.length : 0
    const outCount = Array.isArray(section.items)
      ? section.items.filter((item) => !Boolean(item?.in_stock)).length
      : 0

    const card = document.createElement("button")
    card.type = "button"
    card.className = "category-card"
    card.innerHTML = `
      <span class="category-card__title">${escapeHtml(section.category)}</span>
      <span class="category-card__meta">${totalItems} items - ${outCount} out</span>
    `
    card.addEventListener("click", () => openModalForCategory(index))
    categoriesEl.appendChild(card)
  })
}

const loadSections = async () => {
  const data = await apiFetch(INVENTORY_SECTIONS_PATH)
  sections = Array.isArray(data) ? data : []
  sections.sort((a, b) => String(a?.category || "").localeCompare(String(b?.category || "")))
  renderCategories()
  if (activeCategoryIndex >= 0) renderModal()
}

const findItemById = (id) => {
  const itemId = String(id)
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex]
    const itemIndex = (section.items || []).findIndex((item) => String(item?.id) === itemId)
    if (itemIndex >= 0) {
      return { sectionIndex, itemIndex, item: section.items[itemIndex] }
    }
  }
  return null
}

const toggleInventory = async (id, nextInStock) => {
  const key = String(id)
  if (updatingItemIds.has(key)) return

  const located = findItemById(id)
  if (!located) return

  const previous = Boolean(located.item.in_stock)
  located.item.in_stock = Boolean(nextInStock)
  updatingItemIds.add(key)
  renderCategories()
  renderModal()

  try {
    const updated = await apiFetch(`/api/staff/inventory/${encodeURIComponent(id)}/toggle`, {
      method: "POST",
      body: { in_stock: Boolean(nextInStock) },
    })

    const latest = findItemById(id)
    if (latest) latest.item.in_stock = Boolean(updated?.in_stock)
    showToast(Boolean(updated?.in_stock) ? "Marked in stock" : "Marked out")
  } catch (error) {
    const latest = findItemById(id)
    if (latest) latest.item.in_stock = previous
    showToast(error?.status === 401 ? "Unauthorized" : "Failed to update", "error")
  } finally {
    updatingItemIds.delete(key)
    renderCategories()
    renderModal()
  }
}

const resetInventoryState = () => {
  sections = []
  updatingItemIds = new Set()
  activeCategoryIndex = -1
  renderCategories()
  closeModal()
}

const handleUnauthorized = () => {
  localStorage.removeItem(TOKEN_KEY)
  setAuthState(false)
  resetInventoryState()
  showToast("Unauthorized", "error")
}

const startAuthedSession = async (token, { showWelcome = false } = {}) => {
  await validateToken(token)
  localStorage.setItem(TOKEN_KEY, token)
  setAuthState(true)
  await loadSections()
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
    resetInventoryState()
    showToast(error?.status === 401 ? "Unauthorized" : error.message || "Login failed", "error")
  } finally {
    loginBtn.disabled = false
  }
})

logoutBtn?.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY)
  setAuthState(false)
  resetInventoryState()
  showToast("Signed out")
})

modalCloseBtn?.addEventListener("click", closeModal)

modalEl?.addEventListener("click", (event) => {
  if (event.target === modalEl) closeModal()
})

modalBodyEl?.addEventListener("scroll", updateModalScrollIndicator, { passive: true })

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal()
})

const initialize = async () => {
  setAuthState(false)
  resetInventoryState()

  const token = getToken()
  if (!token) return

  try {
    await startAuthedSession(token)
  } catch (error) {
    localStorage.removeItem(TOKEN_KEY)
    setAuthState(false)
    resetInventoryState()
    showToast(error?.status === 401 ? "Unauthorized" : "Session expired", "error")
  }
}

initialize()
