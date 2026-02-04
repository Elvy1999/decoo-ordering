import { fail } from "./_handlers/shared.js";
import handleMenu from "./_handlers/menu.js";
import handleOrders from "./_handlers/orders.js";
import handleSettings from "./_handlers/settings.js";
import handleHealth from "./_handlers/health.js";
import handleValidateDelivery from "./_handlers/validateDelivery.js";

export default async function handler(req, res) {
  const rawRoute = req.query?.route;
  const route = Array.isArray(rawRoute) ? rawRoute : rawRoute ? [rawRoute] : [];
  const path = `/${route.join("/")}`;

  if (path === "/menu") return handleMenu(req, res);
  if (path === "/orders") return handleOrders(req, res);
  if (path === "/settings") return handleSettings(req, res);
  if (path === "/health") return handleHealth(req, res);
  if (path === "/validate-delivery") return handleValidateDelivery(req, res);

  return fail(res, 404, "NOT_FOUND", "Not found.");
}
