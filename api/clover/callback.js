import { supabaseServerClient } from "../_lib/supabaseServer.js";

function parseCookies(cookieHeader) {
  const out = {};
  (cookieHeader || "").split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = rest.join("=");
  });
  return out;
}

export default async function handler(req, res) {
  try {
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Missing code");

    const stateFromQuery = String(req.query.state || "");
    const cookies = parseCookies(req.headers.cookie);
    if (!stateFromQuery || cookies.clover_oauth_state !== stateFromQuery) {
      return res.status(400).send("Invalid OAuth state");
    }

    const clientId = process.env.CLOVER_CLIENT_ID;
    const clientSecret = process.env.CLOVER_CLIENT_SECRET;
    const redirectUri = process.env.CLOVER_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).send("Server misconfigured (missing Clover env)");
    }

    const tokenResp = await fetch("https://www.clover.com/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
    });

    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) {
      return res.status(400).json({
        ok: false,
        error: "TOKEN_EXCHANGE_FAILED",
        details: tokenData,
      });
    }

    const merchantId = tokenData.merchant_id;
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = Number(tokenData.expires_in);
    const scope = tokenData.scope || null;

    if (!merchantId || !accessToken || !refreshToken || !Number.isFinite(expiresIn)) {
      return res.status(400).json({
        ok: false,
        error: "TOKEN_RESPONSE_INCOMPLETE",
        details: {
          hasMerchantId: !!merchantId,
          hasAccessToken: !!accessToken,
          hasRefreshToken: !!refreshToken,
          expiresIn,
        },
      });
    }

    const expiresAt = new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000).toISOString();

    const supabase = supabaseServerClient();
    const { error } = await supabase.from("clover_tokens").upsert(
      {
        merchant_id: merchantId,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        scope,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "merchant_id" },
    );

    if (error) {
      return res.status(500).json({ ok: false, error: "DB_SAVE_FAILED", details: error });
    }

    res.setHeader("Set-Cookie", "clover_oauth_state=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");

    const successUrl = process.env.CLOVER_OAUTH_SUCCESS_URL || "/admin.html?clover=connected";
    const joinChar = successUrl.includes("?") ? "&" : "?";
    return res.redirect(302, `${successUrl}${joinChar}merchant_id=${encodeURIComponent(merchantId)}`);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "SERVER_ERROR", message: e?.message || String(e) });
  }
}
