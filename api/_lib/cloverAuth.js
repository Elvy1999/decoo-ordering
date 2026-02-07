import { supabaseServerClient } from "./supabaseServer.js";

async function refreshCloverToken(refreshToken) {
  const clientId = process.env.CLOVER_CLIENT_ID;
  const clientSecret = process.env.CLOVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing Clover client env");

  const resp = await fetch("https://www.clover.com/oauth/v2/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error("Clover refresh failed");
    err.details = data;
    throw err;
  }
  return data;
}

export async function resolveCloverMerchantId(preferredMerchantId) {
  if (preferredMerchantId && String(preferredMerchantId).trim()) {
    return String(preferredMerchantId).trim();
  }

  const supabase = supabaseServerClient();
  const { data: row, error } = await supabase
    .from("clover_tokens")
    .select("merchant_id,updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!row?.merchant_id) throw new Error("No Clover merchant_id available (set CLOVER_MERCHANT_ID or complete OAuth install).");
  return row.merchant_id;
}

export async function getValidCloverAccessToken(merchantId) {
  const supabase = supabaseServerClient();

  const { data: row, error } = await supabase
    .from("clover_tokens")
    .select("merchant_id, access_token, refresh_token, expires_at")
    .eq("merchant_id", merchantId)
    .maybeSingle();

  if (error) throw error;
  if (!row) throw new Error(`No Clover token stored for merchant ${merchantId}`);

  const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : 0;
  const now = Date.now();

  if (expiresAtMs && expiresAtMs - now > 2 * 60 * 1000) return row.access_token;

  const refreshed = await refreshCloverToken(row.refresh_token);
  const expiresIn = Number(refreshed.expires_in);
  if (!refreshed?.access_token || !refreshed?.refresh_token || !Number.isFinite(expiresIn)) {
    throw new Error("Clover refresh response missing required fields");
  }
  const newExpiresAt = new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000).toISOString();

  const { error: saveErr } = await supabase
    .from("clover_tokens")
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("merchant_id", merchantId);

  if (saveErr) throw saveErr;

  return refreshed.access_token;
}
