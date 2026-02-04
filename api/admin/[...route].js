import { fail } from "../_handlers/shared.js";
import { requireAdmin } from "../_handlers/admin/auth.js";
import handleAdminMenu from "../_handlers/admin/menu.js";
import handleAdminMenuItem from "../_handlers/admin/menuItem.js";
import handleAdminOrders from "../_handlers/admin/orders.js";
import handleAdminOrder from "../_handlers/admin/order.js";
import handleAdminSettings from "../_handlers/admin/settings.js";
import handleAdminDiag from "../_handlers/admin/diag.js";

export default async function handler(req, res) {
  const rawRoute = req.query?.route;
  const route = Array.isArray(rawRoute) ? rawRoute : rawRoute ? [rawRoute] : [];
  const path = `/${route.join("/")}`;

  if (!requireAdmin(req, res)) return;

  if (path === "/menu") return handleAdminMenu(req, res);
  if (path === "/menu-item") return handleAdminMenuItem(req, res);
  if (path === "/orders") return handleAdminOrders(req, res);
  if (path === "/order") return handleAdminOrder(req, res);
  if (path === "/settings") return handleAdminSettings(req, res);
  if (path === "/diag") return handleAdminDiag(req, res);

  return fail(res, 404, "NOT_FOUND", "Not found.");
}
