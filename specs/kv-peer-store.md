# TAP KV Peer Store Specification

## 1. Purpose & Scope
The KV Peer Store is the authoritative control-plane datastore for TAP peers. It defines identity, endpoints, keys, status, and lifecycle operations for peers communicating over TAP. The design targets distributed, eventually-consistent KV backends (etcd/Consul/DynamoDB/FoundationDB) and prioritizes idempotency, auditability, and safe key rotation.

Out of scope: private key material storage, transport-layer encryption details, and billing/monetization.

## 2. Core Concepts
- **Peer**: A remote TAP agent identified by a stable `peer_id`.
- **Control Plane vs Data Plane**: Writes occur in the control plane; reads/watches are consumed by the data plane.
- **Logical Revocation**: Peers are revoked by status, not deleted.

## 3. Data Model
### Peer
```json
{
  "peer_id": "string",
  "display_name": "string",
  "endpoints": ["https://example.dev/inbox"],
  "status": "pending|active|revoked",
  "labels": {"team": "core"},
  "annotations": {"notes": "optional"},
  "created_at": "RFC3339",
  "updated_at": "RFC3339",
  "version": 1
}
```

### Keys
```json
{
  "key_id": "string",
  "public_key": "base64",
  "algorithm": "ed25519|rsa",
  "status": "active|retiring|revoked",
  "created_at": "RFC3339",
  "expires_at": "RFC3339"
}
```

## 4. KV Schema
- `/tap/peers/<peer_id>/meta`
- `/tap/peers/<peer_id>/status`
- `/tap/peers/<peer_id>/endpoints`
- `/tap/peers/<peer_id>/keys/<key_id>`

All writes SHOULD use CAS/transactions when available.

## 5. Operations
### Add Peer
- Preconditions: `peer_id` does not exist
- Writes: `meta`, `status=pending`, `endpoints`, initial `keys`
- Idempotent on retry

### Activate Peer
- Preconditions: peer exists, keys present
- Writes: `status=active`

### Update Metadata
- Writes: `meta`, bump `version`

### Rotate Keys
- Add new key with `status=active`
- Mark old key `retiring`
- Overlap window REQUIRED
- Cleanup after confirmation

### Revoke Peer
- Write `status=revoked`
- Data plane MUST reject messages from revoked peers

### Hard Delete (GC only)
- Optional, manual, post-retention

## 6. Security Boundaries
- Never store private keys
- Least-privilege KV access
- Audit all writes

## 7. Failure Modes
- Partial writes → retry with CAS
- Stale reads → rely on versioning
- Split brain → last-write-wins with audit
- Watcher lag → tolerate grace periods

## 8. Rotation Hooks
- Pre-rotation validation
- Dual-key overlap
- Post-rotation cleanup

## 9. Compatibility
Backend-agnostic; requires atomic writes and optional watches.

## 10. Open Questions
- Minimum overlap duration defaults
- Mandatory key expiry policy
