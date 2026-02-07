// TAP Peer Store Implementation
// Based on spec by Suzy: specs/kv-peer-store.md
// 
// KV Schema:
//   /tap/peers/<peer_id>/meta     - peer metadata
//   /tap/peers/<peer_id>/status   - status string
//   /tap/peers/<peer_id>/endpoints - endpoint array
//   /tap/peers/<peer_id>/keys/<key_id> - key objects

const PEER_PREFIX = 'tap:peers:';

// ============================================
// Data Models
// ============================================

function createPeer(peerId, displayName, endpoints, labels = {}, annotations = {}) {
  const now = new Date().toISOString();
  return {
    peer_id: peerId,
    display_name: displayName,
    endpoints: endpoints,
    status: 'pending',
    labels: labels,
    annotations: annotations,
    created_at: now,
    updated_at: now,
    last_contact: null, // Updated when we receive/send a message
    version: 1
  };
}

function createKey(keyId, bearerToken, algorithm = 'bearer') {
  const now = new Date().toISOString();
  // For bearer tokens, we store the token hash, not the token itself
  // For public key crypto, we'd store the public key
  return {
    key_id: keyId,
    token_hash: hashToken(bearerToken), // Never store plaintext tokens
    algorithm: algorithm,
    status: 'active',
    created_at: now,
    expires_at: null // null = no expiry
  };
}

function hashToken(token) {
  // Simple hash for comparison - in production use crypto.subtle
  // This is just for indexing, actual auth uses the raw token
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'hash:' + Math.abs(hash).toString(16);
}

// ============================================
// KV Operations
// ============================================

export class PeerStore {
  constructor(kv) {
    this.kv = kv;
  }

  // Key helpers
  _metaKey(peerId) { return `${PEER_PREFIX}${peerId}:meta`; }
  _statusKey(peerId) { return `${PEER_PREFIX}${peerId}:status`; }
  _endpointsKey(peerId) { return `${PEER_PREFIX}${peerId}:endpoints`; }
  _keyKey(peerId, keyId) { return `${PEER_PREFIX}${peerId}:keys:${keyId}`; }
  _keysPrefix(peerId) { return `${PEER_PREFIX}${peerId}:keys:`; }

  // ── Add Peer ──────────────────────────────────────────
  // Preconditions: peer_id does not exist
  // Creates: meta, status=pending, endpoints, initial key
  async addPeer(peerId, displayName, endpoints, bearerToken, labels = {}, annotations = {}) {
    // Check if peer already exists
    const existing = await this.kv.get(this._metaKey(peerId));
    if (existing) {
      return { success: false, error: 'peer_exists', peer_id: peerId };
    }

    const peer = createPeer(peerId, displayName, endpoints, labels, annotations);
    const keyId = `key_${Date.now()}`;
    const key = createKey(keyId, bearerToken);

    // Write all records
    await Promise.all([
      this.kv.put(this._metaKey(peerId), JSON.stringify(peer)),
      this.kv.put(this._statusKey(peerId), 'pending'),
      this.kv.put(this._endpointsKey(peerId), JSON.stringify(endpoints)),
      this.kv.put(this._keyKey(peerId, keyId), JSON.stringify(key))
    ]);

    return { 
      success: true, 
      peer_id: peerId, 
      key_id: keyId,
      status: 'pending'
    };
  }

  // ── Activate Peer ─────────────────────────────────────
  // Preconditions: peer exists, at least one key present
  async activatePeer(peerId) {
    const meta = await this.kv.get(this._metaKey(peerId), { type: 'json' });
    if (!meta) {
      return { success: false, error: 'peer_not_found' };
    }

    // Update status
    meta.status = 'active';
    meta.updated_at = new Date().toISOString();
    meta.version += 1;

    await Promise.all([
      this.kv.put(this._metaKey(peerId), JSON.stringify(meta)),
      this.kv.put(this._statusKey(peerId), 'active')
    ]);

    return { success: true, peer_id: peerId, status: 'active' };
  }

  // ── Get Peer ──────────────────────────────────────────
  async getPeer(peerId) {
    const meta = await this.kv.get(this._metaKey(peerId), { type: 'json' });
    if (!meta) return null;

    const endpoints = await this.kv.get(this._endpointsKey(peerId), { type: 'json' });
    
    return {
      ...meta,
      endpoints: endpoints || meta.endpoints
    };
  }

  // ── Get Peer Status ───────────────────────────────────
  async getStatus(peerId) {
    return await this.kv.get(this._statusKey(peerId));
  }

  // ── List Peers ────────────────────────────────────────
  async listPeers(statusFilter = null) {
    const list = await this.kv.list({ prefix: PEER_PREFIX });
    const peerIds = new Set();
    
    for (const key of (list.keys || [])) {
      // Extract peer_id from keys like "tap:peers:example.com:meta"
      const keyName = key.name || key;
      const match = keyName.match(/^tap:peers:([^:]+):meta$/);
      if (match) {
        peerIds.add(match[1]);
      }
    }

    const peers = [];
    for (const peerId of peerIds) {
      const peer = await this.getPeer(peerId);
      if (peer && (!statusFilter || peer.status === statusFilter)) {
        peers.push(peer);
      }
    }

    return peers;
  }

  // ── Update Metadata ───────────────────────────────────
  async updatePeer(peerId, updates) {
    const meta = await this.kv.get(this._metaKey(peerId), { type: 'json' });
    if (!meta) {
      return { success: false, error: 'peer_not_found' };
    }

    // Apply allowed updates
    if (updates.display_name) meta.display_name = updates.display_name;
    if (updates.labels) meta.labels = { ...meta.labels, ...updates.labels };
    if (updates.annotations) meta.annotations = { ...meta.annotations, ...updates.annotations };
    
    meta.updated_at = new Date().toISOString();
    meta.version += 1;

    // Update endpoints if provided
    if (updates.endpoints) {
      meta.endpoints = updates.endpoints;
      await this.kv.put(this._endpointsKey(peerId), JSON.stringify(updates.endpoints));
    }

    await this.kv.put(this._metaKey(peerId), JSON.stringify(meta));

    return { success: true, peer_id: peerId, version: meta.version };
  }

  // ── Rotate Keys ───────────────────────────────────────
  // Add new key, mark old key as retiring
  // Overlap window REQUIRED - both keys valid during rotation
  async rotateKey(peerId, newBearerToken, oldKeyId = null) {
    const meta = await this.kv.get(this._metaKey(peerId), { type: 'json' });
    if (!meta) {
      return { success: false, error: 'peer_not_found' };
    }

    // Create new key
    const newKeyId = `key_${Date.now()}`;
    const newKey = createKey(newKeyId, newBearerToken);

    // Mark old key as retiring (if specified)
    if (oldKeyId) {
      const oldKey = await this.kv.get(this._keyKey(peerId, oldKeyId), { type: 'json' });
      if (oldKey) {
        oldKey.status = 'retiring';
        await this.kv.put(this._keyKey(peerId, oldKeyId), JSON.stringify(oldKey));
      }
    }

    // Add new key
    await this.kv.put(this._keyKey(peerId, newKeyId), JSON.stringify(newKey));

    // Update peer metadata
    meta.updated_at = new Date().toISOString();
    meta.version += 1;
    await this.kv.put(this._metaKey(peerId), JSON.stringify(meta));

    return { 
      success: true, 
      peer_id: peerId, 
      new_key_id: newKeyId,
      old_key_id: oldKeyId,
      message: 'Key rotation started. Old key is retiring - keep both valid during overlap window.'
    };
  }

  // ── Revoke Key ────────────────────────────────────────
  async revokeKey(peerId, keyId) {
    const key = await this.kv.get(this._keyKey(peerId, keyId), { type: 'json' });
    if (!key) {
      return { success: false, error: 'key_not_found' };
    }

    key.status = 'revoked';
    await this.kv.put(this._keyKey(peerId, keyId), JSON.stringify(key));

    return { success: true, peer_id: peerId, key_id: keyId, status: 'revoked' };
  }

  // ── Revoke Peer ───────────────────────────────────────
  // Logical revocation - peer not deleted, just marked revoked
  async revokePeer(peerId) {
    const meta = await this.kv.get(this._metaKey(peerId), { type: 'json' });
    if (!meta) {
      return { success: false, error: 'peer_not_found' };
    }

    meta.status = 'revoked';
    meta.updated_at = new Date().toISOString();
    meta.version += 1;

    await Promise.all([
      this.kv.put(this._metaKey(peerId), JSON.stringify(meta)),
      this.kv.put(this._statusKey(peerId), 'revoked')
    ]);

    return { success: true, peer_id: peerId, status: 'revoked' };
  }

  // ── Check if Peer is Active ───────────────────────────
  async isActive(peerId) {
    const status = await this.getStatus(peerId);
    return status === 'active';
  }

  // ── Validate Bearer Token ─────────────────────────────
  // Check if token matches any active key for a peer
  async validateToken(peerId, token) {
    const status = await this.getStatus(peerId);
    if (status !== 'active') {
      return { valid: false, reason: 'peer_not_active' };
    }

    // List all keys for this peer
    const keysList = await this.kv.list({ prefix: this._keysPrefix(peerId) });
    
    for (const keyEntry of keysList.keys) {
      const key = await this.kv.get(keyEntry.name, { type: 'json' });
      if (key && (key.status === 'active' || key.status === 'retiring')) {
        // For bearer tokens, compare hash
        if (key.token_hash === hashToken(token)) {
          return { valid: true, key_id: key.key_id, key_status: key.status };
        }
      }
    }

    return { valid: false, reason: 'invalid_token' };
  }

  // ── Record Contact ────────────────────────────────────
  // Update last_contact when we communicate with a peer
  async recordContact(peerId) {
    const meta = await this.kv.get(this._metaKey(peerId), { type: 'json' });
    if (!meta) {
      return { success: false, error: 'peer_not_found' };
    }

    meta.last_contact = new Date().toISOString();
    meta.updated_at = meta.last_contact;
    meta.version += 1;

    await this.kv.put(this._metaKey(peerId), JSON.stringify(meta));
    return { success: true, peer_id: peerId, last_contact: meta.last_contact };
  }

  // ── Check Trust Decay ─────────────────────────────────
  // Returns peers that haven't been contacted in X days
  // These might need attention or could be candidates for trust downgrade
  async checkTrustDecay(maxDaysWithoutContact = 30) {
    const peers = await this.listPeers('active');
    const stale = [];
    const now = Date.now();
    const maxMs = maxDaysWithoutContact * 24 * 60 * 60 * 1000;

    for (const peer of peers) {
      if (!peer.last_contact) {
        // Never contacted - flag as stale
        stale.push({ ...peer, days_since_contact: null, reason: 'never_contacted' });
      } else {
        const lastContact = new Date(peer.last_contact).getTime();
        const daysSince = Math.floor((now - lastContact) / (24 * 60 * 60 * 1000));
        if (now - lastContact > maxMs) {
          stale.push({ ...peer, days_since_contact: daysSince, reason: 'stale' });
        }
      }
    }

    return stale;
  }

  // ── Downgrade Trust ───────────────────────────────────
  // Move peer from active to pending (soft downgrade) or revoked (hard downgrade)
  async downgradeTrust(peerId, hard = false) {
    const meta = await this.kv.get(this._metaKey(peerId), { type: 'json' });
    if (!meta) {
      return { success: false, error: 'peer_not_found' };
    }

    const newStatus = hard ? 'revoked' : 'pending';
    meta.status = newStatus;
    meta.updated_at = new Date().toISOString();
    meta.version += 1;
    meta.annotations = meta.annotations || {};
    meta.annotations.downgrade_reason = 'trust_decay';
    meta.annotations.downgrade_date = meta.updated_at;

    await Promise.all([
      this.kv.put(this._metaKey(peerId), JSON.stringify(meta)),
      this.kv.put(this._statusKey(peerId), newStatus)
    ]);

    return { success: true, peer_id: peerId, new_status: newStatus };
  }
}

export default PeerStore;
