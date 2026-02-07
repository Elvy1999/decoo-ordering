import { supabaseServerClient } from "../_lib/supabaseServer.js";

function parseCookies(cookieHeader) {
  const out = {};
  for (const part of (cookieHeader || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const equalsIdx = trimmed.indexOf("=");
    if (equalsIdx <= 0) continue;

    const key = trimmed.slice(0, equalsIdx).trim();
    const rawValue = trimmed.slice(equalsIdx + 1).trim();
    const unquoted =
      rawValue.startsWith("\"") && rawValue.endsWith("\"")
        ? rawValue.slice(1, -1)
        : rawValue;

    try {
      out[key] = decodeURIComponent(unquoted);
    } catch {
      out[key] = unquoted;
    }
  }
  return out;
}

async function consumeDbOauthState(state) {
  try {
    const supabase = supabaseServerClient();
    const { data, error } = await supabase
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .select("state");

    if (error) {
      console.warn("Clover OAuth state DB consume failed:", error.message || error);
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  } catch (error) {
    console.warn("Clover OAuth state DB consume skipped:", error?.message || String(error));
    return false;
  }
}

export default async function handler(req, res) {
  try {
    const code = String(req.query.code || "");
    if (!code) {
      return res
        .status(400)
        .send("Missing code (OAuth did not complete). Please retry /api/clover/connect in a normal browser.");
    }

    const stateFromQuery = String(req.query.state || "");
    if (!stateFromQuery) return res.status(400).send("Missing OAuth state. Please retry the connect link.");

    const cookies = parseCookies(req.headers.cookie);
    const cookieState = String(cookies.clover_oauth_state || "");
    const cookieStateValid = cookieState === stateFromQuery;
    const dbStateValid = await consumeDbOauthState(stateFromQuery);

    if (!cookieStateValid && !dbStateValid) {
      return res
        .status(400)
        .send("Invalid OAuth state. Please open the connect link in Safari/Chrome (not inside an app).");
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

    const raw = await tokenResp.text();
    let tokenData;
    try {
      tokenData = raw ? JSON.parse(raw) : null;
    } catch {
      tokenData = { raw_html: raw.slice(0, 500) };
    }

    if (!tokenResp.ok) {
      return res.status(400).json({
        ok: false,
        error: "TOKEN_EXCHANGE_FAILED",
        status: tokenResp.status,
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

    res.setHeader(
      "Set-Cookie",
      "clover_oauth_state=; HttpOnly; Path=/; Max-Age=0; SameSite=None; Secure",
    );

    const successUrl = process.env.CLOVER_OAUTH_SUCCESS_URL || "/admin.html?clover=connected";
    const joinChar = successUrl.includes("?") ? "&" : "?";
    return res.redirect(302, `${successUrl}${joinChar}merchant_id=${encodeURIComponent(merchantId)}`);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "SERVER_ERROR", message: e?.message || String(e) });
  }
}
