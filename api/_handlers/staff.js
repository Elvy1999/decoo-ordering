import handleStaffOrders from "./staff/orders.js";
import handleStaffOrderComplete from "./staff/orderComplete.js";
import handleStaffInventorySections from "./staff/inventorySections.js";
import handleStaffInventoryToggle from "./staff/inventoryToggle.js";
import { fail } from "./shared.js";

function normalizePath(path) {
  let normalized = String(path || "").replace(/\/+$/, "");
  if (!normalized) normalized = "/";
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return normalized;
}

function buildPathFromQuery(req) {
  const routeParam = req.query?.route;
  if (Array.isArray(routeParam)) return `/staff/${routeParam.join("/")}`;
  if (typeof routeParam === "string" && routeParam.length > 0) return `/staff/${routeParam}`;
  return "/staff/";
}

export default async function handler(req, res) {
  const path = normalizePath(req.staffPath || buildPathFromQuery(req));

  if (path === "/staff/orders") return handleStaffOrders(req, res);

  const staffOrderCompleteMatch = path.match(/^\/staff\/orders\/([^/]+)\/complete$/);
  if (staffOrderCompleteMatch) {
    req.query = { ...(req.query || {}), id: staffOrderCompleteMatch[1] };
    return handleStaffOrderComplete(req, res);
  }

  if (path === "/staff/inventory/sections") return handleStaffInventorySections(req, res);

  const staffInventoryToggleMatch = path.match(/^\/staff\/inventory\/([^/]+)\/toggle$/);
  if (staffInventoryToggleMatch) {
    req.query = { ...(req.query || {}), id: staffInventoryToggleMatch[1] };
    return handleStaffInventoryToggle(req, res);
  }

  return fail(res, 404, "NOT_FOUND", "Staff endpoint not found.");
}
