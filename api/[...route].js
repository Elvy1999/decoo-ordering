import handleMenu from "./_handlers/menu.js";
import handleOrders from "./_handlers/orders.js";
import handleSettings from "./_handlers/settings.js";
import handleHealth from "./_handlers/health.js";
import handleValidateDelivery from "./_handlers/validateDelivery.js";
import handleValidatePromo from "./_handlers/validatePromo.js";
import handleDiag from "./_handlers/diag.js";
import handleAdminMenu from "./_handlers/admin/menu.js";
import handleAdminMenuItem from "./_handlers/admin/menuItem.js";
import handleAdminOrder from "./_handlers/admin/order.js";
import handleAdminOrders from "./_handlers/admin/orders.js";
import handleAdminReprint from "./_handlers/admin/reprint.js";
import handleAdminSettings from "./_handlers/admin/settings.js";
import { handleAdminPromoCodes } from "./_handlers/admin/promoCodes.js";
import { handleAdminPromoCode } from "./_handlers/admin/promoCode.js";
import { ok, fail, methodNotAllowed } from "./_handlers/shared.js";

function getPath(req) {
  const route = req.query?.route;
  if (Array.isArray(route)) return `/${route.join("/")}`;
  if (typeof route === "string") return `/${route}`;

  if (typeof req.url === "string") {
    const [urlPath] = req.url.split("?");
    if (!urlPath) return "/";
    if (urlPath.startsWith("/api/")) return urlPath.slice(4);
    if (urlPath === "/api") return "/";
    return urlPath;
  }

  return "/";
}

export default async function handler(req, res) {
  const rawPath = getPath(req);
  let path = rawPath.replace(/\/+$/, "");
  if (!path || path === "") path = "/";
  if (!path.startsWith("/")) path = `/${path}`;

  if (path === "/menu") return handleMenu(req, res);
  if (path === "/orders") return handleOrders(req, res);
  if (path === "/settings") return handleSettings(req, res);
  if (path === "/health") return handleHealth(req, res);
  if (path === "/validate-delivery") return handleValidateDelivery(req, res);
  if (path === "/validate-promo") return handleValidatePromo(req, res);
  if (path === "/diag") return handleDiag(req, res);
  if (path === "/reprint") return handleAdminReprint(req, res);

  if (path === "/version") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    return ok(res, {
      ok: true,
      timestamp: new Date().toISOString(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    });
  }

  if (path === "/admin" || path.startsWith("/admin/")) {
    const adminPath = path.replace(/^\/admin\/?/, "");
    switch (adminPath) {
      case "menu":
        return handleAdminMenu(req, res);
      case "menu-item":
        return handleAdminMenuItem(req, res);
      case "orders":
        return handleAdminOrders(req, res);
      case "order":
        return handleAdminOrder(req, res);
      case "settings":
        return handleAdminSettings(req, res);
      case "promo-codes":
        return handleAdminPromoCodes(req, res);
      case "promo-code":
        return handleAdminPromoCode(req, res);
      case "reprint":
        return handleAdminReprint(req, res);
      default:
        return fail(res, 404, "NOT_FOUND", "Admin endpoint not found.");
    }
  }

  if (path === "/payments" || path.startsWith("/payments/")) {
    return fail(res, 501, "NOT_IMPLEMENTED", "Payments are not configured.");
  }

  return fail(res, 404, "NOT_FOUND", "Endpoint not found.");
}
