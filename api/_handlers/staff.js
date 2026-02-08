import handleStaffOrders from "./staff/orders.js";
import handleStaffOrderComplete from "./staff/orderComplete.js";
import handleStaffInventorySections from "./staff/inventorySections.js";
import handleStaffInventoryToggle from "./staff/inventoryToggle.js";
import { ok, fail } from "./shared.js";

function normalizePath(staffPath) {
  let p = String(staffPath || "").trim();

  // Remove query string if it somehow gets included
  p = p.split("?")[0] || "";

  // Collapse multiple slashes and trim trailing slashes
  p = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");

  if (!p) p = "/";

  // Ensure leading slash
  if (!p.startsWith("/")) p = "/" + p;

  // If it ever comes in as /api/staff/..., strip /api once
  if (p === "/api" || p === "/api/") p = "/";
  else if (p.startsWith("/api/")) p = p.slice(4);

  // Ensure it is rooted at /staff
  // Accept: "/staff/..." OR "/orders" OR "/_ping" OR "/inventory/..."
  if (p === "/staff") return "/staff";
  if (!p.startsWith("/staff/")) {
    // If path already starts with /staffSomething (rare), leave it
    // Otherwise prefix with /staff
    p = "/staff" + (p === "/" ? "" : p);
  }

  return p;
}

export default async function handler(req, res) {
  // Ensure staffPath always exists
  if (!req.staffPath) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      let p = u.pathname || "";

      // Strip /api prefix once
      if (p.startsWith("/api/")) p = p.slice(4);

      req.staffPath = p;
    } catch {
      req.staffPath = "/staff";
    }
  }

  const fullPath = normalizePath(req.staffPath);
  const path = fullPath;
  if (path === "/staff/_ping") {
    return ok(res, { hit: "staff-handler", path, staffPath: req.staffPath, route: req.query?.route || null });
  }

  const method = String(req.method || "GET").toUpperCase();
  console.log(`[staff] ${method} ${fullPath}`);

  if (fullPath === "/staff/orders") return handleStaffOrders(req, res);

  const staffOrderCompleteMatch = fullPath.match(/^\/staff\/orders\/([^/]+)\/complete$/);
  if (staffOrderCompleteMatch) {
    req.query = { ...(req.query || {}), id: staffOrderCompleteMatch[1] };
    return handleStaffOrderComplete(req, res);
  }

  if (fullPath === "/staff/inventory/sections") return handleStaffInventorySections(req, res);

  const staffInventoryToggleMatch = fullPath.match(/^\/staff\/inventory\/([^/]+)\/toggle$/);
  if (staffInventoryToggleMatch) {
    req.query = { ...(req.query || {}), id: staffInventoryToggleMatch[1] };
    return handleStaffInventoryToggle(req, res);
  }

  return fail(res, 404, "NOT_FOUND", "Staff endpoint not found.");
}
