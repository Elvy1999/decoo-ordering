import handleStaffOrders from "./staff/orders.js";
import handleStaffOrderComplete from "./staff/orderComplete.js";
import handleStaffInventorySections from "./staff/inventorySections.js";
import handleStaffInventoryToggle from "./staff/inventoryToggle.js";
import { ok, fail } from "./shared.js";

function normalizePath(path) {
  let normalized = String(path || "").replace(/\/+$/, "");
  if (!normalized) normalized = "/";
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return normalized;
}

function staffPathFromUrl(req) {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    let p = u.pathname || "/";

    // strip "/api" once
    if (p === "/api" || p === "/api/") p = "/";
    else if (p.startsWith("/api/")) p = p.slice(4);

    return p; // should now be "/staff/_ping", "/staff/orders", etc.
  } catch {
    return "/";
  }
}

export default async function handler(req, res) {
  const derived = staffPathFromUrl(req);
  const rawStaffPath = normalizePath(req.staffPath);

  // Use derived URL path when staffPath is missing or too generic (/staff)
  const fullPath =
    rawStaffPath === "/staff" || rawStaffPath === "/"
      ? normalizePath(derived)
      : rawStaffPath;

  // Make ping work even if staffPath is wrong/missing
  if (derived === "/staff/_ping" || fullPath === "/staff/_ping") {
    return ok(res, {
      hit: "staff-handler",
      url: req.url || null,
      staffPath: req.staffPath || null,
      derived,
      fullPath,
      route: req.query?.route ?? null,
    });
  }

  const method = String(req.method || "GET").toUpperCase();
  console.log(`[staff] ${method} ${fullPath}`);

  if (fullPath === "/staff/orders") return handleStaffOrders(req, res);

  const staffOrderCompleteMatch = fullPath.match(/^\/staff\/orders\/([^/]+)\/complete$/);
  if (staffOrderCompleteMatch) {
    req.query = { ...(req.query || {}), id: staffOrderCompleteMatch[1] };
    return handleStaffOrderComplete(req, res);
  }

  // inventory sections
  if (fullPath === "/staff/inventory/sections" || fullPath === "/inventory/sections") {
    return handleStaffInventorySections(req, res);
  }

  // inventory toggle
  const staffInventoryToggleMatch = fullPath.match(/^\/(?:staff\/)?inventory\/([^/]+)\/toggle$/);
  if (staffInventoryToggleMatch) {
    req.query = { ...(req.query || {}), id: staffInventoryToggleMatch[1] };
    return handleStaffInventoryToggle(req, res);
  }

  return fail(res, 404, "NOT_FOUND", "Staff endpoint not found.");
}
