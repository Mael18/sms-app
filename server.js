const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const USER = process.env.SMS_USER;
const PASS = process.env.SMS_PASS;
const API = "https://api.sms-gate.app";
const DEVICE_ID = process.env.SMS_DEVICE_ID || "Eeg7soiVJcToQDEDhKaR1";
const FAMILY_PIN = process.env.FAMILY_PIN;
const PUBLIC = path.join(__dirname, "public");

if (!USER || !PASS) {
  console.error("Missing SMS_USER or SMS_PASS.");
  console.error('Start with: export SMS_USER="..." && read -s -p "Password: " SMS_PASS; echo');
  process.exit(1);
}

if (!FAMILY_PIN) {
  console.error("Missing FAMILY_PIN. Set a shared PIN before going live, e.g.:");
  console.error('  export FAMILY_PIN="1234"');
  process.exit(1);
}

// Simple in-memory rate limiting: max 10 sends per IP per 10 minutes.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateLimitHits = new Map(); // ip -> [timestamps]

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

let token = null;
let refreshToken = null;
let expiresAt = 0;

async function getToken() {
  if (token && Date.now() < expiresAt - 60_000) return token;

  let response;
  if (refreshToken) {
    response = await fetch(`${API}/3rdparty/v1/auth/token/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${refreshToken}` }
    });
  }

  if (!response || !response.ok) {
    const basic = Buffer.from(`${USER}:${PASS}`).toString("base64");
    response = await fetch(`${API}/3rdparty/v1/auth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ttl: 3600, scopes: ["messages:send"] })
    });
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gateway authentication failed (HTTP ${response.status}): ${body}`);
  }

  const data = await response.json();
  token = data.access_token;
  refreshToken = data.refresh_token || refreshToken;
  expiresAt = data.expires_at ? Date.parse(data.expires_at) : Date.now() + 55 * 60 * 1000;
  return token;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function serveIndex(res) {
  const file = path.join(PUBLIC, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 500, { error: "Web app missing." });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(data);
  });
}

function normalizePhone(v) {
  v = String(v || "").trim().replace(/[^\d+]/g, "");
  if (/^09\d{9}$/.test(v)) return "+63" + v.slice(1);
  if (/^9\d{9}$/.test(v)) return "+63" + v;
  return v;
}

async function sendSms(body) {
  const to = normalizePhone(body.to);
  const text = String(body.message || "").trim();

  if (!/^\+\d{8,15}$/.test(to)) throw new Error("Invalid recipient number.");
  if (!text) throw new Error("Message is empty.");
  if (text.length > 1600) throw new Error("Message is too long.");

  let accessToken = await getToken();
  let response = await fetch(`${API}/3rdparty/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      phoneNumbers: [to],
      textMessage: { text },
      deviceId: DEVICE_ID
    })
  });

  // If the access token expired/revoked, get a fresh one once and retry.
  if (response.status === 401) {
    token = null;
    accessToken = await getToken();
    response = await fetch(`${API}/3rdparty/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ phoneNumbers: [to], textMessage: { text }, deviceId: DEVICE_ID })
    });
  }

  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw }; }

  if (!response.ok) {
    const err = new Error(`SMS Gateway returned HTTP ${response.status}`);
    err.status = response.status;
    err.gateway = data;
    throw err;
  }

  return { ok: true, gateway: data };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  if (req.method === "GET" && req.url === "/api/health") {
    return json(res, 200, { ok: true, service: "family-sms", time: new Date().toISOString() });
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    return serveIndex(res);
  }

  if (req.method === "POST" && req.url === "/api/send-sms") {
    const ip = clientIp(req);
    let raw = "";
    req.on("error", () => {}); // client aborted mid-upload; ignore, no response needed
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 10000) req.destroy();
    });
    req.on("end", async () => {
      if (req.destroyed) return;
      try {
        const body = JSON.parse(raw || "{}");

        if (String(body.pin || "") !== FAMILY_PIN) {
          return json(res, 401, { ok: false, error: "Incorrect PIN." });
        }
        if (isRateLimited(ip)) {
          return json(res, 429, { ok: false, error: "Too many messages sent recently. Try again later." });
        }

        const result = await sendSms(body);
        json(res, 200, result);
      } catch (e) {
        console.error(e.message);
        json(res, e.status || 500, {
          ok: false,
          error: e.message,
          gateway: e.gateway || undefined
        });
      }
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Family SMS server running on http://127.0.0.1:${PORT}`);
  console.log(`On the same Wi-Fi, use the phone's LAN IP with port ${PORT}.`);
});

// Safety nets: log unexpected errors instead of letting the process die silently.
process.on("uncaughtException", err => console.error("Uncaught exception:", err));
process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));
