# System Design Pattern Review: webex-message-handler

Evaluation of `webex-message-handler` against `system.design.pattern.md` rubric.

**Date:** 2026-04-16
**Scope:** All 4 language implementations (Node.js, Python, Go, Rust)
**Rubric:** system.design.pattern.md v1

---

## Current-State Summary

webex-message-handler is a **receive-only library** that connects to the Webex Mercury WebSocket, decrypts incoming messages via KMS, and emits typed events to consumer callbacks. It is not a service with its own API surface -- it is a client library embedded in the consumer's process.

### Connection sequence (all languages)

```
connect()
  1. Device Registration   (sync HTTP to WDM)
  2. Bot Identity Fetch    (sync HTTP to /people/me, conditional)
  3. Mercury WebSocket Open (async, awaited)
  4. KMS Init via ECDH     (HTTP POST + Mercury response, 30s timeout)
  -> ready
```

### Per-message hot path

```
Mercury WebSocket frame
  -> deserialize activity JSON
  -> replay dedup check (in-memory, 5-min window)
  -> route by verb + objectType
  -> KMS key fetch (cached or 30s round-trip)
  -> JWE decryption
  -> mention parsing (regex)
  -> emit event to consumer callback
```

---

## Contract Violations

### V1. Mercury ACK before decryption (Rubric S2, S3)

| | |
|---|---|
| **Severity** | Medium |
| **Current behavior** | Mercury activity is acknowledged at the WebSocket protocol level immediately on receipt. Decryption and consumer delivery happen after. |
| **Rubric violation** | The library "accepts" the message from Mercury's perspective before it has confirmed local processing succeeded. If decryption fails or the consumer throws, the message is lost. |
| **Affected files** | `handler.ts`, `handler.py`, `handler.go`, `handler.rs` |
| **Proposed fix** | Not directly fixable -- Mercury does not support application-level ACK/NACK. This is an inherent constraint of the Webex Mercury protocol. Document as a known limitation. |
| **Risk** | Low. Decryption failures are rare (key cache hit rate is high). Mercury does not redeliver on NACK anyway. |

**Recommendation: Accept. Document the limitation. No code change needed.**

### V2. connect() conflates acceptance with completion (Rubric S3.1)

| | |
|---|---|
| **Severity** | Low |
| **Current behavior** | `connect()` returns only when the full chain (device reg + Mercury open + KMS init) succeeds. It is synchronous-to-completion. |
| **Rubric violation** | The rubric prefers `202 Accepted` for long chains. But this is a library `connect()`, not an API endpoint. The caller genuinely cannot proceed until the connection is ready. |
| **Proposed fix** | None. This is the correct design for a library -- the caller needs to know the connection is live before registering handlers. |

**Recommendation: No violation. connect() is correctly synchronous because the caller cannot proceed without it.**

---

## Critical Path Risks

### R1. Decryption on the hot path (Rubric S5.1)

| | |
|---|---|
| **Severity** | Medium |
| **Current behavior** | Every incoming activity is decrypted inline before the consumer receives it. KMS key fetch (on cache miss) blocks the entire pipeline for up to 30s. |
| **Rubric concern** | The hot path includes a network call to a third party (KMS) that could spike in latency. |
| **Affected languages** | Node.js, Python, Go process inline. Rust spawns a tokio task (mitigated). |
| **Proposed fix** | None needed for a library. The consumer wants decrypted messages. Moving decryption off the hot path would require a buffer/queue abstraction that doesn't match the library's design intent. Rust's approach (spawning tasks) is the right model for high-throughput scenarios. |

**Recommendation: Accept for library use case. Document that consumers needing guaranteed delivery should wrap with their own queue.**

### R2. No consumer backpressure (Rubric S8.2)

| | |
|---|---|
| **Severity** | Low |
| **Current behavior** | Events are emitted directly to consumer callbacks with no buffering or flow control. If the consumer is slow, activities queue in the language's event system (Node.js event loop, Go channel, Rust mpsc). |
| **Rubric concern** | Unbounded work can starve the system under load. |
| **Affected files** | Rust: `handler.rs` uses `mpsc::unbounded_channel`. Others: direct callback invocation. |
| **Proposed fix** | For the Rust implementation, consider a bounded channel with configurable capacity. For others, document that slow consumers should offload to their own queue. |

**Recommendation: Document. Consider bounded channel for Rust in a future release.**

---

## Reliability Assessment

### What exists (good)

| Pattern | Rubric Section | Status |
|---------|---------------|--------|
| Reconnection with exponential backoff + jitter | S6.3 | Implemented (2^n, max 32s, max 10 attempts) |
| Ping/pong heartbeat with timeout | S6.6 | Implemented (15s/14s) |
| KMS request timeouts | S6.6 | Implemented (30s) |
| Activity replay dedup | S6.1 | Implemented (in-memory, 5-min window) |
| Bounded KMS pending requests | S6.5 | Implemented (max 100) |
| Bounded key cache | S6.5 | Implemented (max 100, cleared on overflow) |
| Message size limit | S6.5 | Implemented (1MB drop) |
| KMS request serialization | S6.5 | Implemented (mutex/lock, FIFO ordering) |
| Auth failure detection | S6.6 | Implemented (4401 = permanent, no retry) |
| URL validation | S7 | Implemented (scheme + domain allowlist) |

### What's missing

| Pattern | Rubric Section | Status | Severity |
|---------|---------------|--------|----------|
| Idempotency keys | S6.1 | N/A | N/A -- receive-only library, no outbound mutations |
| Outbox pattern | S6.2 | N/A | N/A -- no state + event split |
| Dead-letter queue | S6.4 | Missing | Low -- failed decryptions emit error events, consumer decides |
| Circuit breaker for KMS | S6.6 | Missing | Medium -- KMS outage causes 30s stalls per message |
| Distributed tracing / correlation IDs | S6.7 | Partial | Low -- internal UUIDs exist but no OTel integration |
| Retry with backoff for KMS key fetch | S6.3 | Missing | Medium -- KMS key fetch fails fast, no retry |
| Consumer-visible request lifecycle | S3.3 | Partial | Low -- `status()` exists but no per-message tracking |

---

## Third-Party Integration Assessment (Rubric S7)

The library interacts with 4 external Webex services:

| Service | Isolation | On Request Path | Timeout | Retry |
|---------|-----------|----------------|---------|-------|
| WDM (device reg) | Adapter | connect() only | Yes | No (fail fast) |
| /people/me | Adapter | connect() only | Yes | No (fail fast) |
| Mercury WebSocket | Adapter | Persistent | Ping/pong | Reconnect with backoff |
| KMS (key fetch) | Adapter | Per-message (cache miss) | 30s | No |

**Assessment:** Good adapter isolation. Each external service is behind its own client class. The main gap is KMS -- a cache miss puts a 30s-timeout network call on the per-message path with no retry or circuit breaker.

**Recommendation:**

| Priority | Action |
|----------|--------|
| P1 | Add KMS key fetch retry (1-2 attempts with short backoff) before failing |
| P2 | Add circuit breaker for KMS -- if N consecutive failures, skip decryption and emit error rather than blocking 30s per message |
| P3 | Consider prefetching keys for active conversations on reconnect |

---

## Observability Assessment (Rubric S9)

| Requirement | Status | Gap |
|-------------|--------|-----|
| Request latency | Not tracked | No per-message timing metrics |
| Queue depth | N/A | No internal queue |
| Retry counts | Partial | Reconnect attempts tracked; KMS has no retry |
| Downstream latency | Not tracked | No timing on WDM/KMS/Mercury calls |
| End-to-end tracing | Missing | No correlation ID from Mercury frame to consumer callback |
| Structured logging | Implemented | All languages use structured logger interface |
| Status endpoint | Implemented | `status()` returns connection/KMS/device state |
| Error events | Implemented | `error` event with typed error objects |

**Recommendation:**

| Priority | Action |
|----------|--------|
| P2 | Add optional timing metrics (connect duration, decryption latency, KMS fetch latency) via callback or logger |
| P3 | Add optional OTel trace context propagation for consumers that want distributed tracing |
| P3 | Add activity ID to all log lines for per-message correlation |

---

## Rubric Sections Not Applicable

These sections of the rubric do not apply to a receive-only client library:

| Section | Reason |
|---------|--------|
| S2 (Request/Work/Event lanes) | Library is a consumer, not a service with API endpoints |
| S3 (API contract / 202 Accepted) | No API surface |
| S4 (Reference architecture) | Not a service |
| S6.2 (Outbox pattern) | No state mutations + event publishing |
| S6.4 (Dead-letter queue) | No internal job queue |
| S8 (Capacity/scaling) | Single-instance library |
| S10 (UX contract) | No user-facing surface |
| S14 (Interface-agnostic core) | Library, not service |
| S15 (Authorization boundary) | Webex token auth handled by upstream services |
| S16 (AI/MCP surface) | Not applicable |
| S17 (Provenance vs SoR) | Not applicable |
| S18 (Renderer pattern) | Not applicable |
| S19 (Human approval) | Not applicable |

---

## Target-State Recommendations

### Tier 1: Quick wins (low effort, high value)

1. **KMS key fetch retry** -- Add 1-2 retry attempts with 1s backoff before failing. Covers transient KMS errors without major architecture change.
   - Files: `kms_client.{ts,py,go,rs}`
   - Effort: Small
   - Risk: None

2. **Document Mercury ACK-before-decrypt limitation** -- Add a "Delivery Guarantees" section to READMEs explaining that the library provides at-most-once delivery semantics.
   - Files: `README.md` (all 4)
   - Effort: Trivial

### Tier 2: Moderate improvements

3. **KMS circuit breaker** -- After N consecutive KMS failures (e.g., 3), enter degraded mode: skip decryption, emit raw activities with an `encrypted: true` flag, and attempt KMS recovery on a timer.
   - Files: `kms_client.{ts,py,go,rs}`, `handler.{ts,py,go,rs}`
   - Effort: Medium
   - Risk: API surface change (new event or field)

4. **Optional timing metrics** -- Expose connection, decryption, and KMS fetch latencies via an optional metrics callback.
   - Files: `handler.{ts,py,go,rs}`, `types.{ts,py,go,rs}`
   - Effort: Medium

5. **Bounded channel in Rust** -- Replace `mpsc::unbounded_channel` with a bounded channel (configurable, default 1000) to provide backpressure.
   - Files: `rust/src/handler.rs`
   - Effort: Small

### Tier 3: Architectural (future consideration)

6. **OTel trace context** -- Propagate trace IDs from Mercury activity through decryption to consumer callback for consumers that use distributed tracing.
   - Effort: Medium-Large
   - Depends on consumer adoption

---

## Summary Verdict

| Rubric Area | Score | Notes |
|-------------|-------|-------|
| Truthful boundaries | Good | Library correctly represents what it knows |
| Sync vs async separation | Good | connect() is correctly sync; message processing is async |
| Request path hygiene | Good | Only KMS cache miss is a concern |
| Reliability patterns | Strong | Reconnect, dedup, timeouts, bounded caches all present |
| Third-party isolation | Strong | Clean adapter pattern per external service |
| Observability | Adequate | Structured logging + status endpoint; lacks timing metrics |
| Overall | **Solid for a client library** | Most rubric sections target services with API surfaces; this library handles the applicable sections well |

The system design pattern rubric is primarily written for **services with API endpoints, queues, and workers**. As a **receive-only client library**, webex-message-handler is not the target audience for roughly half the rubric. For the applicable sections -- reliability, third-party isolation, timeouts, bounded resources, error surfacing -- the library scores well. The main actionable gaps are KMS retry/circuit-breaker and optional observability metrics.
