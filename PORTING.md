# Porting Guide — Implementation Insights & Gotchas

This document captures every non-obvious detail, debugging insight, and protocol quirk discovered while building `webex-message-handler` across four languages. If you're porting this to a new language, reading this first will save you significant debugging time.

## The Core Architectural Insight: Two-Channel KMS

**This is the single most important thing to understand.** Webex KMS does not work like a normal request/response API.

```
Your Code                    Webex Cloud
   │                             │
   ├── HTTP POST /kms/messages ──►│  (sends encrypted request)
   │◄── HTTP 202 Accepted ───────┤  (NOT the response — just an ack)
   │                             │
   │  ... time passes ...        │
   │                             │
   │◄── Mercury WebSocket ───────┤  (actual KMS response arrives here)
   │    eventType:               │
   │    "encryption.kms_message" │
```

- You POST your KMS request (ECDH handshake, key retrieval) to the encryption service HTTP endpoint
- You get back a **202 Accepted** — this is NOT your response, just confirmation the request was queued
- The actual response arrives asynchronously over the **Mercury WebSocket** as an `encryption.kms_message` event
- You must correlate responses to requests (FIFO ordering works — responses arrive in request order)

**Implementation pattern:** Create a pending-request map/queue. When you POST a KMS request, register a promise/channel/oneshot keyed by request ID. When a `encryption.kms_message` arrives on Mercury, resolve the oldest pending request. Set a timeout (30s) in case the response never arrives.

## Message Encryption: `dir` Not `A256KW`

**This caused failures in all three non-Node ports.** Webex message content uses:

```
alg: "dir"    (NOT "A256KW")
enc: "A256GCM"
```

With `alg: "dir"`, the content encryption key (CEK) **is** the key directly — there is no key-wrapping step. The JWE encrypted_key field is **empty** (zero bytes).

With `alg: "A256KW"`, the CEK is wrapped (encrypted) with AES Key Wrap, and you must unwrap it first.

**You must support both.** Parse the JWE header, check the `alg` field, and dispatch accordingly:
- `"dir"` → key bytes ARE the CEK, decrypt ciphertext directly with AES-256-GCM
- `"A256KW"` → unwrap the encrypted_key with AES Key Wrap to get the CEK, then decrypt

If you only implement `A256KW`, you'll get errors like "unexpected key algorithm dir" or buffer underflows when the encrypted_key is empty.

## KMS Response Format: JWE vs JWS (Count the Dots)

KMS responses come in two formats depending on the operation:

```
JWE (5 parts): header.encrypted_key.iv.ciphertext.tag     → encrypted, must decrypt
JWS (3 parts): header.payload.signature                    → signed only, extract payload
```

- **ECDH handshake response** → typically JWS (3 parts). Just base64url-decode the payload (part 2).
- **Key retrieval response** → typically JWE (5 parts). Decrypt with the ECDH-derived symmetric key.

**Detection:** Split on `.` and count parts. 5 = JWE, 3 = JWS. Don't assume one or the other.

## ECDH Handshake Sequence

The full KMS initialization flow:

1. **GET encryption service details** (`GET {encryptionServiceUrl}/kms/{userId}`)
   - Returns `kmsCluster` (URL) and `rsaPublicKey` (JWK)
   - **Gotcha:** `rsaPublicKey` may be a JSON string containing a JWK, OR a JWK object directly. Parse both.

2. **Generate local ECDH keypair** — P-256 curve (secp256r1)

3. **Build ECDH create request:**
   ```json
   {
     "client": { "clientId": "<deviceURL>", "credential": { "userId": "...", "bearer": "..." } },
     "method": "create",
     "uri": "<kmsCluster>/ecdhe",
     "requestId": "<uuid>",
     "jwk": { <your P-256 public key as JWK> }
   }
   ```

4. **Wrap with RSA-OAEP + A256GCM** using the server's RSA public key. This is a JWE.

5. **POST to** `{encryptionServiceUrl}/kms/messages` with body:
   ```json
   { "destination": "<kmsCluster>", "kmsMessages": ["<JWE compact string>"] }
   ```

6. **Wait for Mercury response** (the two-channel pattern described above)

7. **Unwrap response** — may be JWS or JWE (see above). Extract the response body JSON.

8. **Extract remote public key** from response at `body.key.jwk` (or `body.key` directly, or `key.jwk`)

9. **Derive shared secret:**
   - ECDH: your private key × their public key → shared secret bytes
   - HKDF: SHA-256, **no salt** (`null`), **no info** (`null`), output 32 bytes
   - Result: 256-bit symmetric key (use as `oct` JWK with `A256KW` algorithm)

10. **Store the derived key** with the `kid` set to the remote key URI from the response (`body.key.uri`)

## Key Retrieval (After Handshake)

Once you have the ECDH-derived symmetric key, fetching content keys is simpler:

1. **Build retrieve request:**
   ```json
   {
     "client": { "clientId": "...", "credential": { ... } },
     "method": "retrieve",
     "uri": "<kms://...key URL>",
     "requestId": "<uuid>"
   }
   ```

2. **Wrap with derived key** — `alg: "dir"`, `enc: "A256GCM"`, `kid: "<remote key URI>"`
   - The derived symmetric key IS the CEK (direct encryption, no key wrapping)

3. **POST and wait** (same two-channel pattern)

4. **Unwrap response** and extract the content key from `body.key.jwk` (or `body.key`)

5. **Cache the key** by its URI — same key is reused for all messages in a conversation

## Mercury WebSocket Protocol

### Connection

1. Connect to the WebSocket URL from device registration
2. Append query params: `outboundWireFormat=text&bufferStates=true&aliasHttpStatus=true&clientTimestamp=<ms>`
3. **Auth is NOT via HTTP headers.** After the WebSocket opens, send:
   ```json
   { "id": "<uuid>", "type": "authorization", "data": { "token": "Bearer <token>" } }
   ```
4. Wait for a message with `data.eventType` of `mercury.buffer_state` or `mercury.registration_status` — this signals the connection is ready

### Ping/Pong

Mercury uses **application-level JSON ping/pong**, not WebSocket protocol pings:

```json
// Send:
{ "id": "<uuid>", "type": "ping" }

// Receive:
{ "id": "<same uuid>", "type": "pong" }
```

Send pings every ~15 seconds. If pong doesn't arrive within ~14 seconds, consider the connection dead and reconnect.

### Message Routing

Every Mercury message with `data.eventType` needs routing:

| eventType | Action |
|-----------|--------|
| `encryption.kms_message` | Route to KMS response handler (resolve pending request) |
| `conversation.activity` | Parse activity, decrypt, emit event |
| `mercury.buffer_state` | Connection ready signal |
| `mercury.registration_status` | Connection ready signal |

**Send ACKs** for activity messages:
```json
{ "messageId": "<message.id>", "type": "ack" }
```

## Activity Structure

### Message Created
```
verb: "post"
object.objectType: "comment"
```

### Message Deleted
```
verb: "delete"
object.objectType: "activity"
```

### Encryption Key URL Location

The `encryptionKeyUrl` that tells you which key to fetch can be in **three different places** — check in this order:

1. `activity.encryptionKeyUrl` (root level)
2. `activity.object.encryptionKeyUrl`
3. `activity.target.encryptionKeyUrl`

If none are present, the message is not encrypted (pass through as-is).

### Field Mapping (Counterintuitive)

- `object.displayName` → **plain text** of the message (yes, "displayName" is the text)
- `object.content` → **HTML** version of the message (rich text)
- `actor.emailAddress` → sender's email
- `target.id` → room/space ID
- `target.tags` → `["ONE_ON_ONE"]` = direct message, `["TEAM"]`/`["GROUP"]`/`["LOCKED"]` = group

### JSON Flexibility

Webex may omit fields in nested objects. Don't make any field strictly required except `id` and `verb` at the root level. Use optional types / defaults for everything in `actor`, `object`, and `target`.

## Concurrency Pitfalls

### The Event Loop Deadlock (Rust, but applies to any async runtime)

This is the most subtle bug we encountered. The pattern:

```
Event Loop:
  1. Receives conversation.activity
  2. Calls handle_activity()
  3. handle_activity() calls kms.get_key()
  4. get_key() POSTs HTTP request, then WAITS for Mercury response
  5. Mercury response is queued in... this same event loop
  6. DEADLOCK — step 4 is waiting for step 5, but step 5 can't run until step 4 finishes
```

**Solution:** Spawn activity handling in a **separate task/goroutine/thread**. The event loop must never block waiting for something that arrives on the same event loop.

### The Lock Deadlock (Also Rust, but relevant for any mutex-based design)

If your KMS client is behind a mutex and your `connect()` method:
1. Locks the KMS client
2. Calls `kms.initialize()` which waits for a Mercury response
3. The Mercury event handler tries to lock the same KMS client to deliver the response
4. DEADLOCK

**Solution:** Separate the "receive KMS responses" handler from the KMS client object. The response handler should have its own lock (or use a lock-free channel). We used a separate `KmsResponseHandler` struct in Rust.

### Go Approach (Simpler)

Go's goroutine model avoids most of these issues naturally:
- Activity handling runs in `go func()` (separate goroutine)
- KMS response delivery uses channels
- No shared mutex across the event path

### Python Approach

Python's asyncio is single-threaded, but because `await` yields control, the event loop can process Mercury messages while `get_key()` is awaiting. No special handling needed — but make sure you're not holding any synchronous locks across await points.

## WDM Device Registration

The WebSocket URL, device URL, user ID, and service catalog all come from device registration:

```
POST https://wdm-a.wbx2.com/wdm/api/v1/devices
Authorization: Bearer <token>
Content-Type: application/json

{
  "deviceName": "webex-message-handler",
  "deviceType": "DESKTOP",
  "localizedModel": "<language>",
  "model": "<language>",
  "name": "webex-message-handler",
  "systemName": "webex-message-handler",
  "systemVersion": "1.0.0"
}
```

Response includes:
- `webSocketUrl` — Mercury WebSocket endpoint
- `url` — device URL (use as `clientId` in KMS requests)
- `userId` — your bot's user ID
- `services.encryptionServiceUrl` — KMS encryption service base URL

## JOSE Library Requirements

Your JOSE/JWE library must support ALL of these:

| Operation | Algorithm | Encryption |
|-----------|-----------|------------|
| KMS ECDH handshake (wrap request) | RSA-OAEP | A256GCM |
| KMS key retrieval (wrap request) | dir | A256GCM |
| KMS response (unwrap) | ECDH-ES, ECDH-ES+A256KW, A256KW, dir | A256GCM, A128GCM |
| Message decryption | dir, A256KW | A256GCM |
| JWS payload extraction | (just base64url decode part 2) | — |

If your language's JOSE library doesn't support `dir` + `A256GCM`, you'll need to implement it manually:
- Parse the 5-part JWE compact format
- Base64url-decode each part
- Skip key unwrapping (encrypted_key is empty for `dir`)
- Decrypt with AES-256-GCM using: key=CEK, iv=IV, ciphertext, tag, AAD=base64url(header)

## Library Recommendations by Language

Tested and working combinations:

| Language | HTTP | WebSocket | JOSE/Crypto | Async |
|----------|------|-----------|-------------|-------|
| Node.js | built-in fetch | `ws` | `node-jose` | native async/await |
| Python | `aiohttp` | `aiohttp` (built-in) | `jwcrypto` | `asyncio` |
| Go | `net/http` | `nhooyr.io/websocket` | `go-jose/v4` | goroutines + channels |
| Rust | `reqwest` | `tokio-tungstenite` | `josekit` + manual JWE | `tokio` |

**Rust note:** `josekit` handles RSA-OAEP and ECDH-ES but we implemented `dir` + `A256GCM` and `A256KW` + `A256GCM` decryption manually using `aes-gcm` and `aes-kw` crates, because josekit's API was awkward for those cases.

## Common Mistakes (In Order of How Much Time They Waste)

1. **Assuming KMS is request/response** — It's two-channel. Your HTTP POST gets 202, the real response comes via WebSocket. If you don't wire up the Mercury → KMS response handler before calling initialize, you'll timeout every time.

2. **Only implementing `A256KW` for message decryption** — Messages use `dir`. You'll parse the JWE, try to unwrap an empty encrypted_key, and crash or get garbage.

3. **Making JSON fields required** — Webex omits fields freely. A strict schema will fail on real traffic.

4. **Blocking the event loop with KMS requests** — Any language with a single-threaded event loop (or shared mutexes) will deadlock if you handle activities synchronously in the message receive loop.

5. **Not handling both JWE and JWS responses from KMS** — The handshake response is typically JWS, key responses are JWE. Count the dots.

6. **Forgetting Mercury auth is in-band** — Auth is a JSON message sent after WebSocket open, not an HTTP header.

7. **Not caching KMS keys** — Every message in a room uses the same key. Without caching, you'll make a KMS round-trip for every single message.

8. **RSA public key format ambiguity** — The `rsaPublicKey` field from the encryption service may be a string-encoded JWK or a JWK object. Handle both.
