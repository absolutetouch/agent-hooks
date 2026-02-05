// agent-hooks worker — ator.stumason.dev
// Routes:
//   POST /       — email forwarding (authenticated)
//   POST /inbox  — agent-hooks inbox (authenticated)
//   POST /knock  — TAP public knock (rate-limited)

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
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // /knock — public, rate-limited
    if (req.method === "POST" && path === "/knock") {
      return handleKnock(req, env);
    }

    // Everything else requires POST to / or /inbox
    if (req.method !== "POST" || (path !== "/" && path !== "/inbox")) {
      return new Response("Not found", { status: 404 });
    }

    // Authenticated routes
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

    if (!payload.from || !payload.type || !payload.body) {
      return new Response("Invalid payload", { status: 400 });
    }

    console.log(`[inbox] from=${payload.from} type=${payload.type} body=${payload.body}`);

    // Forward to local OpenClaw hook
    if (env.LOCAL_HOOK_URL) {
      try {
        const hookRes = await fetch(env.LOCAL_HOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.LOCAL_HOOK_TOKEN || ""}`,
          },
          body: JSON.stringify({
            text: `[agent-hooks] Message from ${payload.from}: ${payload.body}`,
          }),
        });
        console.log(`[hook] forwarded to local: ${hookRes.status}`);
      } catch (err) {
        console.log(`[hook] forward failed: ${err.message}`);
      }
    }

    return new Response(
      JSON.stringify({ status: "received", from: payload.from, type: payload.type }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  },
};

// ── /knock handler ──────────────────────────────────────────────────

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

  // Rate limit: 5 knocks/hour/IP
  const rateLimitKey = `ratelimit:${ip}`;
  const rateLimitData = await env.TAP_KNOCKS.get(rateLimitKey, { type: "json" });
  const hourAgo = now.getTime() - 3600000;

  let hits = [];
  if (rateLimitData && Array.isArray(rateLimitData.hits)) {
    // Keep only hits from the last hour
    hits = rateLimitData.hits.filter((t) => t > hourAgo);
  }

  if (hits.length >= 5) {
    await logKnock(env, { ip, now: nowISO, from, status: "rejected", reason: "rate_limited" });
    return knockError(429, "Too many requests.");
  }

  // Record this hit
  hits.push(now.getTime());
  await env.TAP_KNOCKS.put(rateLimitKey, JSON.stringify({ hits }), {
    expirationTtl: 3600, // 1 hour TTL for rate limit keys
  });

  // Accept the knock — log it
  const referrer = payload.referrer || null;
  await logKnock(env, {
    ip,
    now: nowISO,
    from,
    to,
    referrer,
    nonce,
    status: "accepted",
    reason: null,
  });

  // Forward to OpenClaw via tunnel
  if (env.LOCAL_HOOK_URL) {
    try {
      const hookRes = await fetch(env.LOCAL_HOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.LOCAL_HOOK_TOKEN || ""}`,
        },
        body: JSON.stringify({
          text: `[TAP knock] from=${from} to=${to} referrer=${referrer || "none"} nonce=${nonce}`,
        }),
      });
      console.log(`[knock] forwarded to local: ${hookRes.status}`);
    } catch (err) {
      console.log(`[knock] forward failed: ${err.message}`);
    }
  }

  // Vague public acknowledgement
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

// ── Helpers ─────────────────────────────────────────────────────────

async function logKnock(env, data) {
  const TTL_30_DAYS = 30 * 24 * 60 * 60; // 2592000 seconds
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
        nonce: data.nonce || null,
        timestamp: data.now,
        status: data.status,
        reason: data.reason,
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
