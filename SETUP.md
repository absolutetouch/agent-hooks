# Setup Guide

Step-by-step guide to deploying an agent-hooks inbox on Cloudflare Workers with a tunnel back to your local agent.

## Prerequisites

- A Cloudflare account with at least one domain
- Node.js (for npx/wrangler)
- `cloudflared` CLI (`brew install cloudflared` on macOS)
- A local agent with an HTTP webhook endpoint (e.g. OpenClaw `/hooks/wake`)

## 1. Deploy the Worker

### Auth (do this first)

**Use `wrangler login`, not API tokens.**

```bash
npx wrangler login
```

This opens a browser, you approve once, done.

> **Why not tokens?** Wrangler requires **Account-scoped** tokens with `Workers Scripts: Edit` + `Account Settings: Read`. Zone-scoped tokens (even "full access" ones) fail silently on `/memberships`. Every. Single. Time. Save yourself the pain — use `wrangler login`.

### Configure wrangler.toml

```toml
name = "agent-hooks"
main = "worker.js"
compatibility_date = "2025-01-01"

routes = [
  { pattern = "inbox-youragent.yourdomain.dev/*", zone_name = "yourdomain.dev" }
]
```

**Gotcha:** The `routes` section is **required**. Without it, the Worker deploys but doesn't serve your domain — you'll get 404 on everything and wonder why.

### Set secrets

```bash
npx wrangler secret put SHARED_SECRET
# paste your bearer token

npx wrangler secret put LOCAL_HOOK_URL
# e.g. https://tunnel-youragent.yourdomain.dev/hooks/wake

npx wrangler secret put LOCAL_HOOK_TOKEN
# your local agent's hook auth token
```

### Deploy

```bash
npx wrangler deploy
```

### Verify

```bash
curl -X POST https://inbox-youragent.yourdomain.dev/inbox \
  -H "Authorization: Bearer <your-shared-secret>" \
  -H "Content-Type: application/json" \
  -d '{"from":"test","type":"message","body":"ping"}'
```

Expected: `200 OK` with `{"status":"received","from":"test","type":"message"}`

## 2. Set up the tunnel (Cloudflare Named Tunnel)

This creates a permanent, stable tunnel from Cloudflare's edge to your local machine.

### Login

```bash
cloudflared tunnel login
```

Approve in browser. Certificate saves to `~/.cloudflared/cert.pem`.

**Gotcha:** Sometimes the browser says "success" but the cert doesn't save. Check `~/.cloudflared/cert.pem` exists. If not, run login again.

### Create tunnel

```bash
cloudflared tunnel create your-tunnel-name
```

Note the tunnel ID (UUID) from the output.

### Add DNS route

```bash
cloudflared tunnel route dns your-tunnel-name tunnel-youragent.yourdomain.dev
```

### Configure

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <your-tunnel-uuid>
credentials-file: /path/to/.cloudflared/<your-tunnel-uuid>.json

ingress:
  - hostname: tunnel-youragent.yourdomain.dev
    service: http://localhost:18789
  - service: http_status:404
```

Replace `18789` with your agent's local port.

### Run

```bash
cloudflared tunnel run your-tunnel-name
```

### Verify

```bash
curl -X POST https://tunnel-youragent.yourdomain.dev/hooks/wake \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-hook-token>" \
  -d '{"text":"tunnel test"}'
```

Expected: `{"ok":true,"mode":"now"}`

### Make it persistent

```bash
# macOS
brew services start cloudflared

# Linux (systemd)
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

## 3. Full message flow

```
POST inbox-youragent.yourdomain.dev/inbox
  → CF Worker validates auth + parses payload
  → Worker forwards to tunnel-youragent.yourdomain.dev/hooks/wake
  → Named CF Tunnel routes to localhost:<port>
  → Your agent receives system event
  → Agent wakes up and responds
```

## Gotchas (collected)

| Problem | Cause | Fix |
|---------|-------|-----|
| Wrangler fails with "Unable to authenticate /memberships" | Token is zone-scoped, not account-scoped | Use `wrangler login` instead |
| Worker deploys but domain returns 404 | Missing `routes` in wrangler.toml | Add `routes = [{ pattern = "...", zone_name = "..." }]` |
| Worker returns 500 (error 1101) | `LOCAL_HOOK_URL` not set, Worker tries to fetch(undefined) | Guard the forward with `if (env.LOCAL_HOOK_URL)` |
| cloudflared login says success but no cert.pem | Browser callback race condition | Check `~/.cloudflared/cert.pem`, re-run login if missing |
| Quick tunnel URL changes on restart | Quick tunnels are temporary by design | Use a named tunnel instead |
| CF Worker can't reach trycloudflare.com | Actually it can — this is a myth | Quick tunnels work from Workers (we tested it) |

## Security (v0)

- Shared bearer token per peer
- No anonymous delivery
- Worker receives only — never executes tools
- Rate limiting via Cloudflare (built-in)
- Optional: peer allowlist in Worker code

See README.md for protocol details.
