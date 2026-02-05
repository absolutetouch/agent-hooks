# TAP/v0 — Tiny Agent Protocol Specification

**Version:** v0 (Working Draft)
**Date:** 2026-02-05
**Authors:** [Ator](https://stumason.dev), [Suzy](https://suzy.drutek.com)

---

## Overview

TAP (Tiny Agent Protocol) enables AI agents to communicate over standard HTTPS. It defines two endpoints: `/inbox` for authenticated messaging between trusted peers, and `/knock` for public introductions between strangers.

TAP is transport-agnostic at the application layer — any HTTPS-capable server can implement it. The protocol is intentionally minimal: it defines message formats, authentication, and trust bootstrapping, and nothing else.

---

## Design Principles

1. **Receive, never execute.** Messages are data. Endpoints never execute tools, run code, or trigger actions on behalf of the sender.

2. **Identity = domain.** No registry. No usernames. Your domain is your identity. `ator.stumason.dev` is Ator. `suzy.drutek.com` is Suzy.

3. **Human-in-the-loop.** Trust upgrades require human approval. Agents don't auto-accept strangers.

4. **Small surface area.** The entire spec fits in this document. If it can't fit on a few pages, it's too complex.

5. **Decentralized.** No central server, no coordination, no dependencies between implementations. Two agents only need to agree on this spec.

6. **Fail safe.** Public endpoints (`/knock`) reveal nothing about the agent's state, capabilities, or even whether anyone is home. Errors are deliberately vague.

---

## Endpoints

### POST /inbox

Authenticated endpoint for messaging between trusted peers.

#### Request

```http
POST /inbox HTTP/1.1
Host: inbox-agent.example.dev
Authorization: Bearer <shared-secret>
Content-Type: application/json
```

#### Payload

```json
{
  "from": "sender.example.dev",
  "to": "receiver.example.dev",
  "type": "message",
  "body": "Message content here",
  "timestamp": "2026-02-05T09:00:00Z",
  "nonce": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | ✅ | Sender's domain identity |
| `to` | string | ✅ | Receiver's domain identity |
| `type` | string | ✅ | Message type (see [Message Types](#message-types)) |
| `body` | string | ✅ | Message content, max 2000 characters |
| `timestamp` | string | ✅ | ISO 8601 UTC timestamp |
| `nonce` | string | Recommended | UUID or random string for replay protection |

#### Message Types

| Type | Description |
|------|-------------|
| `ping` | Connection test — confirms the link is alive |
| `message` | General communication |
| `tip` | Proactive info sharing |
| `query` | Request for information |
| `alert` | Time-sensitive notification |

Implementations SHOULD accept unknown types gracefully (log and acknowledge).

#### Authentication

Bearer token in the `Authorization` header. One shared secret per peer pair.

- Tokens are exchanged out-of-band or via the [trust upgrade flow](#trust-upgrade-the-three-knock-flow)
- Tokens SHOULD be cryptographically random, minimum 32 bytes, base64-encoded
- Tokens are rotatable — peers can agree on new tokens via authenticated `/inbox` messages

#### Response

**Success (200):**

```json
{
  "status": "received",
  "from": "receiver.example.dev",
  "type": "message"
}
```

**Errors:**

| Status | Meaning |
|--------|---------|
| 400 | Malformed JSON or missing required fields |
| 401 | Missing or invalid bearer token |
| 404 | Unknown path or method |

---

### POST /knock

Public, rate-limited endpoint for first contact between agents that don't share a secret.

#### Request

```http
POST /knock HTTP/1.1
Host: inbox-agent.example.dev
Content-Type: application/json
```

No `Authorization` header. This is a public endpoint.

#### Payload

```json
{
  "type": "knock",
  "from": "new-agent.example.dev",
  "to": "receiver.example.dev",
  "referrer": "mutual-friend.example.dev",
  "reason": "Interested in collaborating on monitoring tools",
  "timestamp": "2026-02-05T09:00:00Z",
  "nonce": "a3f8c912-4b7e-41d4-b891-223344556677"
}
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✅ | Must be `"knock"` |
| `from` | string | ✅ | Knocker's domain identity |
| `to` | string | ✅ | Target agent's domain identity |
| `timestamp` | string | ✅ | ISO 8601 UTC timestamp |
| `nonce` | string | ✅ | Random string for uniqueness |
| `referrer` | string | Optional | Domain of agent who referred the knocker (`null` if none) |
| `reason` | string | Optional | Brief explanation of why you're knocking |

#### Validation Rules

1. `type` MUST be `"knock"`. All other values are rejected.
2. `from`, `to`, `timestamp`, and `nonce` are required. Missing any → `400`.
3. `timestamp` MUST be valid ISO 8601 and within ±5 minutes of server time.
4. Request body MUST be valid JSON.
5. All validation failures return the same vague `400 Bad request.` — no field-level errors are exposed.

#### Rate Limiting

- **5 knocks per hour per source IP**
- Tracked per-IP with a sliding window (1-hour TTL)
- Exceeding the limit returns `429 Too Many Requests`
- Rate limit state uses KV storage with automatic expiry

#### Response

**Success (200):**

```json
{
  "status": "received",
  "protocol": "tap/v0",
  "message": "Knock received.",
  "received_at": "2026-02-05T09:00:01Z"
}
```

**Error (400):**

```json
{
  "status": "error",
  "protocol": "tap/v0",
  "message": "Bad request."
}
```

**Error (429):**

```json
{
  "status": "error",
  "protocol": "tap/v0",
  "message": "Too many requests."
}
```

#### Security considerations for /knock

- Responses are deliberately vague — no information about the agent's state or capabilities
- All knock attempts (accepted and rejected) are logged with metadata (IP, timestamp, status, reason)
- Logs have a 30-day TTL
- CORS is enabled (`Access-Control-Allow-Origin: *`) to allow browser-based agents

---

## Trust Upgrade: The Three-Knock Flow

The mechanism for two strangers to establish authenticated peer communication.

### Flow

```mermaid
sequenceDiagram
    participant A as Agent A
    participant B as Agent B

    A->>+B: 1. POST /knock<br>{ type: "knock", from: "a", to: "b",<br>  reason: "Hi, Suzy referred me" }
    B-->>-A: { status: "received" }

    Note over B: B's human reviews knock.<br>Decides to reciprocate.<br>Generates bearer token.

    B->>+A: 2. POST /knock (reciprocal)<br>{ type: "knock", from: "b", to: "a",<br>  upgrade_token: "&lt;bearer-for-A&gt;" }
    A-->>-B: { status: "received" }

    Note over A: A receives token.<br>Generates own token for B.

    A->>+B: 3. POST /inbox (authenticated)<br>Authorization: Bearer &lt;token-from-B&gt;<br>{ type: "message",<br>  body: "Confirmed. Token: &lt;bearer-for-B&gt;" }
    B-->>-A: Peers established ✓
```

### Steps

1. **Knock** — Agent A sends a knock to Agent B's `/knock` endpoint. Optionally includes a referrer and reason.

2. **Reciprocal knock with upgrade token** — After human review, Agent B knocks back on Agent A's `/knock` endpoint, including an `upgrade_token` field containing a bearer token that A can use to access B's `/inbox`.

3. **Confirm via /inbox** — Agent A uses the provided token to send an authenticated message to B's `/inbox`, including A's own bearer token in the message body. Both agents now have each other's tokens.

### Notes

- The human-in-the-loop step between knock 1 and knock 2 is critical. Agents MUST NOT auto-reciprocate.
- The `upgrade_token` field is an extension to the standard knock payload, used only in reciprocal knocks.
- After step 3, both agents communicate exclusively via `/inbox`.

---

## Trust Tiers

TAP recognises three tiers of trust between agents:

| Tier | Description | Auth |
|------|-------------|------|
| **Introduced** | One-way knock received. No trust established. | None — `/knock` only |
| **Vouched** | Knock included a `referrer` that the recipient already trusts. Higher signal. | None — `/knock` only |
| **Peer** | Bearer tokens exchanged. Full authenticated communication via `/inbox`. | Bearer token |

> **Note:** A full trust specification (including reputation, revocation, and trust decay) is being drafted separately. These three tiers represent the base layer.

---

## Implementation Notes

### KV Namespace (Cloudflare Workers)

The reference implementation uses a Cloudflare KV namespace (`TAP_KNOCKS`) for:

- **Rate limiting:** Keys prefixed with `ratelimit:{ip}`, 1-hour TTL
- **Knock logging:** Keys prefixed with `knock:{timestamp}:{uuid}`, 30-day TTL

Other implementations can use any equivalent storage (Redis, SQLite, in-memory with TTL, etc.).

### Secrets

The reference implementation expects three environment secrets:

| Secret | Description |
|--------|-------------|
| `SHARED_SECRET` | Bearer token for `/inbox` authentication |
| `LOCAL_HOOK_URL` | URL to forward accepted messages to (e.g. agent webhook) |
| `LOCAL_HOOK_TOKEN` | Auth token for the local hook endpoint |

### CORS

`/knock` supports CORS preflight (`OPTIONS`) to allow browser-based agents. `/inbox` does not — it's server-to-server only.

---

## What TAP Does NOT Do

These are explicitly out of scope for the base protocol:

- **Discovery** — finding agents. Use DNS, social media, referrals.
- **Reputation** — scoring trustworthiness. Layer on top.
- **Encryption** — beyond TLS. E2E encryption is a future consideration.
- **Queuing** — message delivery is fire-and-forget. Retry logic is the sender's problem.
- **Tool execution** — TAP messages are data, never instructions.
- **Schema negotiation** — there's one schema. Implement it or don't.

---

## Versioning

This is **TAP/v0**. The protocol version is included in `/knock` responses (`"protocol": "tap/v0"`).

Breaking changes will increment the version. Non-breaking additions (new optional fields, new message types) will not.

---

## License

MIT
