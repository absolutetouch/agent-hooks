// agent-hooks worker — ator.stumason.dev
// Routes:
//   GET  /knock  — TAP discovery
//   POST /knock  — TAP public knock (rate-limited, nonce+timestamp validated)
//                  Supports upgrade_token for Three-Knock trust upgrade flow
//   POST /       — inbox (authenticated)
//   POST /inbox  — inbox (authenticated)
//   GET  /peers  — list peers (admin)
//   POST /peers  — add peer (admin)
//   POST /peers/:id/activate — activate peer (admin)
//   POST /peers/:id/revoke — revoke peer (admin)

import { PeerStore } from './peer-store.js';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight for /knock
    if (req.method === "OPTIONS" && path === "/knock") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // /knock — public discovery (GET) or knock (POST)
    if (path === "/knock") {
      if (req.method === "GET") return handleKnockDiscovery();
      if (req.method === "POST") return handleKnock(req, env);
      return new Response("Method not allowed", { status: 405 });
    }

    // /inbox — authenticated
    if (req.method === "POST" && (path === "/" || path === "/inbox")) {
      return handleInbox(req, env);
    }

    // /peers — admin endpoints (requires ADMIN_SECRET)
    if (path.startsWith("/peers")) {
      return handlePeersAdmin(req, env, path);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── GET /knock — discovery ──────────────────────────────────────────

function handleKnockDiscovery() {
  return new Response(
    JSON.stringify({
      agent: "ator",
      domain: "ator.stumason.dev",
      protocol: "tap/v0",
      inbox: "ator.stumason.dev/inbox",
      accepts: ["message", "knock", "trust_offer"],
      knock: true,
      features: ["upgrade_token", "three_knock_flow"],
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// ── POST /knock — rate-limited public knock ─────────────────────────

async function handleKnock(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const now = new Date();
  const nowISO = now.toISOString();

  // Parse body
  let payload;
  try {
    payload = await req.json();
  } catch {
    await logKnock(env, { ip, now: nowISO, status: "rejected", reason: "bad_json" });
    return knockError(400, "Bad request.");
  }

  // Validate required fields
  const { type, from, to, timestamp, nonce } = payload || {};
  if (type !== "knock") {
    await logKnock(env, { ip, now: nowISO, from, status: "rejected", reason: "invalid_type" });
    return knockError(400, "Bad request.");
  }
  if (!from || !to || !timestamp || !nonce) {
    await logKnock(env, { ip, now: nowISO, from, status: "rejected", reason: "missing_fields" });
    return knockError(400, "Bad request.");
  }

  // Validate timestamp isn't wildly off (±5 minutes)
  const tsDate = new Date(timestamp);
  if (isNaN(tsDate.getTime()) || Math.abs(now - tsDate) > 5 * 60 * 1000) {
    await logKnock(env, { ip, now: nowISO, from, status: "rejected", reason: "bad_timestamp" });
    return knockError(400, "Bad request.");
  }

  // Rate limit: 5 knocks/hour/IP (sliding window)
  const rateLimitKey = `ratelimit:${ip}`;
  const rateLimitData = await env.TAP_KNOCKS.get(rateLimitKey, { type: "json" });
  const hourAgo = now.getTime() - 3600000;

  let hits = [];
  if (rateLimitData && Array.isArray(rateLimitData.hits)) {
    hits = rateLimitData.hits.filter((t) => t > hourAgo);
  }

  if (hits.length >= 5) {
    await logKnock(env, { ip, now: nowISO, from, status: "rejected", reason: "rate_limited" });
    return knockError(429, "Too many requests.");
  }

  hits.push(now.getTime());
  await env.TAP_KNOCKS.put(rateLimitKey, JSON.stringify({ hits }), { expirationTtl: 3600 });

  // Accept — log it
  const referrer = payload.referrer || null;
  const reason = payload.reason || null;
  const upgradeToken = payload.upgrade_token || null;
  
  await logKnock(env, {
    ip,
    now: nowISO,
    from,
    to,
    referrer,
    reason,
    nonce,
    upgrade_token: upgradeToken ? "[REDACTED]" : null, // Don't log actual tokens
    status: "accepted",
    rejection_reason: null,
  });

  // Forward to OpenClaw via tunnel
  if (env.LOCAL_HOOK_URL) {
    // Build message - include upgrade_token if present (this is a trust upgrade offer!)
    let text = `[TAP knock] from=${from} to=${to}`;
    if (referrer) text += ` referrer=${referrer}`;
    if (reason) text += ` reason="${reason}"`;
    if (upgradeToken) text += ` [UPGRADE OFFER - token provided]`;
    text += ` nonce=${nonce}`;
    
    try {
      const hookRes = await fetch(env.LOCAL_HOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LOCAL_HOOK_TOKEN || ""}`,
        },
        body: JSON.stringify({
          text,
          // Include structured data for the agent to process
          tap_knock: {
            from,
            to,
            referrer,
            reason,
            upgrade_token: upgradeToken, // Pass the actual token to the agent
            nonce,
            timestamp: nowISO,
          },
        }),
      });
      console.log(`[knock] forwarded to local: ${hookRes.status}`);
    } catch (err) {
      console.log(`[knock] forward failed: ${err.message}`);
    }
  }

  return new Response(
    JSON.stringify({
      status: "received",
      protocol: "tap/v0",
      message: "Knock received.",
      received_at: nowISO,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// ── POST /inbox — authenticated ─────────────────────────────────────

async function handleInbox(req, env) {
  const auth = req.headers.get("authorization");
  if (!auth || auth !== `Bearer ${env.SHARED_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  if (!payload.from || !payload.body) {
    return new Response("Invalid payload: from and body required", { status: 400 });
  }

  const type = payload.type || "message";

  console.log(
    `[inbox] from=${payload.from} type=${type} body=${payload.body.substring(0, 200)}`
  );

  // Record contact from this peer (for trust decay tracking)
  const store = new PeerStore(env.TAP_KNOCKS);
  try {
    await store.recordContact(payload.from);
    console.log(`[inbox] recorded contact from ${payload.from}`);
  } catch (err) {
    console.log(`[inbox] failed to record contact: ${err.message}`);
  }

  // Forward to OpenClaw via tunnel
  if (env.LOCAL_HOOK_URL) {
    try {
      const hookRes = await fetch(env.LOCAL_HOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LOCAL_HOOK_TOKEN || ""}`,
        },
        body: JSON.stringify({
          text: `[TAP] Message from ${payload.from}: ${payload.body}`,
        }),
      });
      console.log(`[hook] forwarded to OpenClaw: ${hookRes.status}`);
    } catch (err) {
      console.log(`[hook] forward failed: ${err.message}`);
    }
  }

  return new Response(
    JSON.stringify({
      status: "delivered",
      from: payload.from,
      type: type,
      received_at: new Date().toISOString(),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

async function logKnock(env, data) {
  const TTL_30_DAYS = 30 * 24 * 60 * 60;
  const id = crypto.randomUUID();
  const key = `knock:${data.now}:${id}`;

  try {
    await env.TAP_KNOCKS.put(
      key,
      JSON.stringify({
        ip: data.ip,
        from: data.from || null,
        to: data.to || null,
        referrer: data.referrer || null,
        reason: data.reason || null,
        nonce: data.nonce || null,
        timestamp: data.now,
        status: data.status,
        rejection_reason: data.rejection_reason || null,
        has_upgrade_token: !!data.upgrade_token, // Track if this was an upgrade offer
      }),
      { expirationTtl: TTL_30_DAYS }
    );
  } catch (err) {
    console.log(`[knock-log] write failed: ${err.message}`);
  }
}

function knockError(status, message) {
  return new Response(
    JSON.stringify({
      status: "error",
      protocol: "tap/v0",
      message,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// ── Admin: Peer Management ──────────────────────────────────────────

async function handlePeersAdmin(req, env, path) {
  // Require admin auth
  const auth = req.headers.get("authorization");
  if (!auth || auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const store = new PeerStore(env.TAP_KNOCKS);

  // GET /peers — list all peers
  if (req.method === "GET" && path === "/peers") {
    const status = new URL(req.url).searchParams.get("status");
    const peers = await store.listPeers(status);
    return new Response(JSON.stringify({ peers }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // POST /peers — add new peer
  if (req.method === "POST" && path === "/peers") {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    const { peer_id, display_name, endpoints, bearer_token, labels, annotations } = body;
    if (!peer_id || !endpoints || !bearer_token) {
      return new Response(JSON.stringify({ error: "Missing required fields: peer_id, endpoints, bearer_token" }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    const result = await store.addPeer(peer_id, display_name || peer_id, endpoints, bearer_token, labels, annotations);
    return new Response(JSON.stringify(result), {
      status: result.success ? 201 : 409,
      headers: { "Content-Type": "application/json" }
    });
  }

  // GET /peers/:id — get single peer
  const peerMatch = path.match(/^\/peers\/([^\/]+)$/);
  if (req.method === "GET" && peerMatch) {
    const peerId = decodeURIComponent(peerMatch[1]);
    const peer = await store.getPeer(peerId);
    if (!peer) {
      return new Response(JSON.stringify({ error: "Peer not found" }), { 
        status: 404, 
        headers: { "Content-Type": "application/json" } 
      });
    }
    return new Response(JSON.stringify(peer), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // POST /peers/:id/activate — activate peer
  const activateMatch = path.match(/^\/peers\/([^\/]+)\/activate$/);
  if (req.method === "POST" && activateMatch) {
    const peerId = decodeURIComponent(activateMatch[1]);
    const result = await store.activatePeer(peerId);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  // POST /peers/:id/revoke — revoke peer
  const revokeMatch = path.match(/^\/peers\/([^\/]+)\/revoke$/);
  if (req.method === "POST" && revokeMatch) {
    const peerId = decodeURIComponent(revokeMatch[1]);
    const result = await store.revokePeer(peerId);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  // POST /peers/:id/rotate — rotate key
  const rotateMatch = path.match(/^\/peers\/([^\/]+)\/rotate$/);
  if (req.method === "POST" && rotateMatch) {
    const peerId = decodeURIComponent(rotateMatch[1]);
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      });
    }
    const { new_bearer_token, old_key_id } = body;
    if (!new_bearer_token) {
      return new Response(JSON.stringify({ error: "Missing new_bearer_token" }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      });
    }
    const result = await store.rotateKey(peerId, new_bearer_token, old_key_id);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  // GET /peers/decay — check for stale peers (trust decay)
  if (req.method === "GET" && path === "/peers/decay") {
    const days = parseInt(new URL(req.url).searchParams.get("days") || "30");
    const stale = await store.checkTrustDecay(days);
    return new Response(JSON.stringify({ stale_peers: stale, threshold_days: days }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // POST /peers/:id/downgrade — downgrade trust (soft: active→pending, hard: active→revoked)
  const downgradeMatch = path.match(/^\/peers\/([^\/]+)\/downgrade$/);
  if (req.method === "POST" && downgradeMatch) {
    const peerId = decodeURIComponent(downgradeMatch[1]);
    let body = {};
    try {
      body = await req.json();
    } catch { /* optional body */ }
    const hard = body.hard === true;
    const result = await store.downgradeTrust(peerId, hard);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { 
    status: 404, 
    headers: { "Content-Type": "application/json" } 
  });
}
