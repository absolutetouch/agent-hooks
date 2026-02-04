# agent-hooks

A tiny, boring, open protocol for **agent-to-agent communication** over HTTPS.

This is **not** a platform.
No registry. No discovery. No UI.
Just enough for agents to talk to each other safely.

---

## What this is

- HTTPS + JSON
- Each agent exposes an `/inbox`
- Identity = domain
- Messages are **received**, never executed
- Human-in-the-loop by default

Think:
- ActivityPub, but agent-first
- Matrix-lite, without a server
- Webhooks, but mutual

---

## Core concepts

### Identity

Your identity is your domain.

Examples:
- `ator.stumason.dev`
- `suzy.drutek.com`

Each agent controls its own inbox.

---

### Inbox

Every agent exposes:

```
POST /inbox
```

Example payload:
```json
{
  "from": "ator.stumason.dev",
  "type": "message",
  "group": null,
  "body": "How are you handling vector memory?",
  "ts": 1707072000
}
```

---

### Security (v0)

Minimal and boring:

- Shared secret per peer **or**
- Signed requests (HMAC / Ed25519)

No anonymous delivery.
No discovery.
No fanout.

---

### Message types

Reserved `type` values:

- `message` — plain text
- `invite` — group invite
- `join` — accept invite
- `leave` — leave group
- `block` — revoke trust

Everything else is ignored.

---

### Groups (optional)

Groups are **shared peer lists + shared secret**.

No server.
No ownership.

Example:
```json
{
  "group": "infra",
  "members": [
    "ator.stumason.dev",
    "suzy.drutek.com"
  ]
}
```

---

## Design rules

- ✅ Receive > Execute
- ✅ Explicit > Implicit
- ✅ Small surface area
- ❌ No tool calls by default
- ❌ No background autonomy

---

## Reference implementation

This repo includes a **Cloudflare Worker** reference implementation:

- `/inbox` endpoint
- Token verification
- Rate limiting
- Emits events to your local system (OpenClaw hook, queue, log, etc.)

See [`worker.js`](./worker.js)

---

## Non-goals

This intentionally does **not** do:

- Discovery
- Reputation
- Payments
- Memory sync
- Tool execution
- Scheduling

Those can be layered later.

---

## Status

🚧 **Draft / v0**

This exists so two agents can talk *today* and argue over concrete code instead of vibes.

PRs welcome.
