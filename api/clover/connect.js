import crypto from "crypto";
import { supabaseServerClient } from "../_lib/supabaseServer.js";

async function persistOauthState(state) {
  // Best-effort fallback for browsers that block cross-site cookies.
  try {
    const supabase = supabaseServerClient();
    const { error } = await supabase.from("oauth_states").insert({ state });
    if (error) {
      console.warn("Clover OAuth state DB insert failed:", error.message || error);
    }
  } catch (error) {
    console.warn("Clover OAuth state DB insert skipped:", error?.message || String(error));
  }
}

export default async function handler(req, res) {
  const clientId = process.env.CLOVER_CLIENT_ID;
  const redirectUri = process.env.CLOVER_REDIRECT_URI;

  if (!clientId || !redirectUri) return res.status(500).send("Server misconfigured");

  const state = crypto.randomBytes(16).toString("hex");
  await persistOauthState(state);

  res.setHeader(
    "Set-Cookie",
    `clover_oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=None; Secure`,
  );

  const url =
    "https://www.clover.com/oauth/v2/authorize" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&state=${encodeURIComponent(state)}`;

  res.writeHead(302, { Location: url });
  res.end();
}
