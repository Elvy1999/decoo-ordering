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
import handleAdminStatsSummary from "./_handlers/admin/statsSummary.js";
import { handleAdminPromoCodes } from "./_handlers/admin/promoCodes.js";
import { handleAdminPromoCode } from "./_handlers/admin/promoCode.js";
import handleStaff from "./_handlers/staff.js";
import { ok, fail, methodNotAllowed } from "./_handlers/shared.js";

function getPath(req) {
  const route = req.query?.route;

  // Preferred: Vercel catch-all param
  if (Array.isArray(route) && route.length) {
    let p = "/" + route.map(String).filter(Boolean).join("/");
    p = p.replace(/\/{2,}/g, "/"); // collapse /////
    p = p.replace(/^\/?/, "/"); // ensure leading /
    p = p.replace(/^\/api(\/|$)/, "/"); // strip leading /api once if it somehow appears
    return p === "" ? "/" : p;
  }

  if (typeof route === "string" && route.trim()) {
    let p = "/" + route.replace(/^\/+/, "");
    p = p.replace(/\/{2,}/g, "/");
    p = p.replace(/^\/api(\/|$)/, "/");
    return p === "" ? "/" : p;
  }

  // Fallback: parse URL safely
  let pathname = "/";
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    pathname = u.pathname || "/";
  } catch {
    pathname = String(req.url || "/").split("?")[0] || "/";
  }

  pathname = pathname.replace(/\/{2,}/g, "/");

  if (pathname === "/api" || pathname === "/api/") pathname = "/";
  else if (pathname.startsWith("/api/")) pathname = pathname.slice(4);

  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return pathname === "" ? "/" : pathname;
}

export default async function handler(req, res) {
  let fullPath = getPath(req).replace(/\/+$/, "");
  if (!fullPath || fullPath === "") fullPath = "/";
  if (!fullPath.startsWith("/")) fullPath = `/${fullPath}`;

  if (fullPath === "/route-debug") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    const simulate = req.query?.path ? String(req.query.path) : null;
    let simulatedFullPath = "/";
    if (simulate) {
      const simulatedRoute = simulate
        .replace(/^\/+/, "")
        .split("/")
        .filter(Boolean);
      let fp = getPath({ query: { route: simulatedRoute } }).replace(/\/+$/, "");
      if (!fp || fp === "") fp = "/";
      if (!fp.startsWith("/")) fp = `/${fp}`;
      simulatedFullPath = fp;
    }

    return ok(res, {
      host: req.headers?.host || null,
      route: req.query?.route || null,
      fullPath,
      simulate,
      simulatedFullPath,
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

  if (fullPath === "/staff" || fullPath.startsWith("/staff/")) {
    req.staffPath = fullPath;
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
      case "stats/summary":
      case "stats/daily":
        return handleAdminStatsSummary(req, res);
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
