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
import handleStaff from "./_handlers/staff.js";
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
  const rawFullPath = getPath(req);
  let fullPath = rawFullPath.replace(/\/+$/, "");
  if (!fullPath || fullPath === "") fullPath = "/";
  if (!fullPath.startsWith("/")) fullPath = `/${fullPath}`;
  if (fullPath === "/api") fullPath = "/";
  else if (fullPath.startsWith("/api/")) fullPath = fullPath.slice(4) || "/";

  if (fullPath === "/route-debug") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    // simulate another path if provided
    const simulate = req.query?.path ? String(req.query.path) : null;
    const simulatedUrl = simulate ? `/api${simulate.startsWith("/") ? simulate : `/${simulate}`}` : null;

    // reuse your getPath logic by temporarily overriding req.url
    const originalUrl = req.url;
    const originalQuery = req.query;
    if (simulatedUrl) {
      req.url = simulatedUrl;
      if (originalQuery && typeof originalQuery === "object") {
        const nextQuery = { ...originalQuery };
        delete nextQuery.route;
        req.query = nextQuery;
      }
    }

    const raw = getPath(req);
    let fp = raw.replace(/\/+$/, "");
    if (!fp || fp === "") fp = "/";
    if (!fp.startsWith("/")) fp = `/${fp}`;
    if (fp === "/api") fp = "/";
    else if (fp.startsWith("/api/")) fp = fp.slice(4) || "/";

    // restore
    req.url = originalUrl;
    req.query = originalQuery;

    return ok(res, {
      host: req.headers?.host || null,
      url: originalUrl,
      route: req.query?.route || null,
      rawFullPath,
      fullPath,
      simulate,
      simulatedUrl,
      simulatedRawFullPath: raw,
      simulatedFullPath: fp,
    });
  }

  if (fullPath === "/menu") return handleMenu(req, res);
  if (fullPath === "/orders") return handleOrders(req, res);
  if (fullPath === "/settings") return handleSettings(req, res);
  if (fullPath === "/health") return handleHealth(req, res);
  if (fullPath === "/validate-delivery") return handleValidateDelivery(req, res);
  if (fullPath === "/validate-promo") return handleValidatePromo(req, res);
  if (fullPath === "/diag") return handleDiag(req, res);
  if (fullPath === "/reprint") return handleAdminReprint(req, res);

  // Normalize all staff routes
  if (fullPath === "/staff" || fullPath.startsWith("/staff/")) {
    req.staffPath = fullPath;
    return handleStaff(req, res);
  }

  // Safety: handle leaked /api prefix
  if (fullPath.startsWith("/api/staff")) {
    const staffPath = fullPath.replace(/^\/api/, "");
    req.staffPath = staffPath;
    return handleStaff(req, res);
  }

  if (fullPath === "/version") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    return ok(res, {
      ok: true,
      timestamp: new Date().toISOString(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    });
  }

  if (fullPath === "/admin" || fullPath.startsWith("/admin/")) {
    const adminPath = fullPath.replace(/^\/admin\/?/, "");
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

  if (fullPath === "/payments" || fullPath.startsWith("/payments/")) {
    return fail(res, 501, "NOT_IMPLEMENTED", "Payments are not configured.");
  }

  return fail(res, 404, "NOT_FOUND", "Endpoint not found.");
}
