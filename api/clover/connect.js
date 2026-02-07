import crypto from "crypto";

export default function handler(req, res) {
  const clientId = process.env.CLOVER_CLIENT_ID;
  const redirectUri = process.env.CLOVER_REDIRECT_URI;

  if (!clientId || !redirectUri) return res.status(500).send("Server misconfigured");

  const state = crypto.randomBytes(16).toString("hex");

  res.setHeader(
    "Set-Cookie",
    `clover_oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`,
  );

  const url =
    "https://www.clover.com/oauth/v2/authorize" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  res.writeHead(302, { Location: url });
  res.end();
}
