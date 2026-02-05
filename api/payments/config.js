import { ok, fail, methodNotAllowed } from "../_handlers/shared.js";

export default function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const merchantId = process.env.CLOVER_MERCHANT_ID;
  const publicKey = process.env.CLOVER_ECOMM_PUBLIC_KEY;

  if (!merchantId || !publicKey) {
    return fail(res, 500, "SERVER_CONFIG_ERROR", "Server configuration error.");
  }

  return ok(res, { ok: true, merchantId, publicKey });
}
