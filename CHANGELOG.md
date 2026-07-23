# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.15] - 2026-07-23

### Fixed
- **Adaptive-Card `Action.Submit` inputs always empty over Mercury** — when a
  user clicks a card's submit button, Webex delivers a `conversation.activity`
  with `verb="cardAction"` / `object.objectType="submit"`, and `object.inputs`
  arrives as a **JWE-encrypted string** (encrypted under the activity's
  `encryptionKeyUrl`, same key as message content). The parser type-asserted
  `inputs` as an object and silently dropped the string, so
  `AttachmentAction.Inputs` was always empty — the `onAttachmentActionCreated`
  callback fired but carried no form values. The parser now captures the raw
  JWE string, the message decryptor decrypts it (dir/A256GCM) and parses the
  JSON, and the card-action handler routes the activity through the decryptor
  before emitting. On decrypt failure it warns and falls through with empty
  inputs (never throws). Confirmed live: inputs now decrypt to the card's
  `data` payload. (all 4 languages)

## [0.6.14] - 2026-07-21

### Fixed
- **Zero `conversation.activity` over Mercury for non-`wdm-a` orgs (#27)** — the
  library hard-coded the WDM endpoint `wdm-a.wbx2.com` and never performed
  service discovery. Webex assigns each org to a region; registering a device
  in the wrong region produces a socket that authorizes and completes the KMS
  handshake but never receives that org's conversation activities (REST still
  works). Now, before registering, the library discovers the org-correct WDM
  base from U2C (`GET https://u2c.wbx2.com/u2c/api/v1/catalog?format=hostmap`,
  `serviceLinks.wdm`), validates the host against the Webex allowlist, and falls
  back to `wdm-a` only if discovery fails. Verified end-to-end in a previously
  failing sandbox org (registers `wdm-r`, 3/3 messages received). (all 4
  languages) — thanks to Webex Engineering for the region diagnosis.

## [0.6.13] - 2026-07-19

### Security
- **ReDoS in mention parsing (CodeQL `js/polynomial-redos`, high)** — the
  `<spark-mention>` regex used two unbounded `[^>]*` around the attribute, which
  backtracks polynomially on crafted message HTML. Rewritten to match the tag
  with a single bounded `[^>]*` and extract attributes from the captured tag.
  Fixed in **Node.js** and **Python** (both backtracking engines); Go (RE2) and
  Rust (`regex` crate) are linear-time and were never vulnerable. Added
  mention-parser unit tests incl. a ReDoS regression guard.

### Fixed
- **Device registration leak → per-user cap 403 (#26)** — device registration
  now lists existing WDM devices and reuses/refreshes one matching this client's
  name+deviceType instead of POSTing a new device on every connect. On a 403
  "excessive device registrations" it reaps this client's own devices and
  retries once. Prevents long-lived services from silently marching into a hard
  WDM lockout across restarts/crash-loops. (all 4 languages)
- **Go: `Reconnect` token write now synchronized** — `h.token` was written
  without the mutex while the native WS dial reads it under `RLock`; guarded to
  remove the data race (found by review; `go test -race` clean).

### Changed
- **Go: WS-upgrade `Authorization` header + `includeUpstreamServices=all`** —
  the native dial now presents the token on the upgrade request and registration
  requests the full upstream-service catalog, matching the reference Webex SDKs.
  *(Investigated as a candidate fix for #27 but not the cause — see below.)*
- **Dependency bumps to latest:** Go `golang.org/x/crypto` 0.49→0.54,
  `github.com/coder/websocket` 1.8.14→1.8.15 (supersedes Dependabot #25);
  Node `undici` 8.5→8.7.

### Notes
- **#27 (zero `conversation.activity` over Mercury)** — at 0.6.13 this was
  believed to be a Webex sandbox-org backend limitation. **Superseded by 0.6.14:**
  the true root cause was client-side — the library registered against the wrong
  WDM region. Fixed by U2C region discovery in 0.6.14. (The production-vs-sandbox
  contrast that pointed here: production orgs happen to map to `wdm-a`, which the
  library hard-coded.) See `docs/mercury-sandbox-activity-report.md`.

## [0.6.12] - 2026-06-03

### Security
- **Node.js: bumped `undici` 7.24.6 → 8.5.0** — the v7 line carried 7 advisories
  (incl. CVE-2026-12151, High); 8.5.0 is the current release with all of them
  fixed. Resolves Dependabot PR #24. Also remediated dev-tool transitives via
  pnpm overrides: `js-yaml >=4.2.0`, `esbuild >=0.28.1`, `@babel/core >=7.29.6`.
- **Python: bumped crypto/HTTP floors** — `aiohttp>=3.14.1` (7 CVEs:
  CVE-2026-50269/-54274/-54275/-54276/-54277/-54278/-54280) and
  `cryptography>=48.0.1` (GHSA-537c-gmf6-5ccf). Both are in the KMS/JWE path.
- **Go: bumped the `go` directive 1.26.2 → 1.26.4** — remediates two called
  standard-library advisories: GO-2026-5039 (`net/textproto` error escaping,
  hit via `io.ReadAll` in `fetchBotPersonID`) and GO-2026-5037 (`crypto/x509`
  hostname parsing, hit via TLS cert verification). `govulncheck` now reports 0.

### Changed
- **Node.js: raised minimum Node to `>=24.0.0`** (was `>=22.4.0`) — required by
  `undici` 8.x (`>=22.19.0`) and aligned to the active Node LTS line (24,
  "Krypton"). **Breaking for consumers still on Node 22.x.**

### Removed
- **Python: dropped the `aioresponses` dev dependency** — it does not support
  aiohttp 3.14's internal `ClientResponse` API, which blocked the security
  bump. Device-manager tests now mock at the injected `http_do` adapter seam
  (new `MockHttpDo` test helper in `conftest.py`), which is closer to how the
  library is actually wired and removes the upstream-compat coupling.

## [0.6.11] - 2026-06-02

### Security
- **Node.js: dropped the `uuid` dependency** — replaced `uuid.v4()` with the
  built-in `crypto.randomUUID()` (available since the required Node ≥22.4.0).
  Removes the direct `uuid` dependency entirely, resolving the Dependabot bump
  to the ESM-only `uuid` 14.x (#21) without a config workaround. Also pinned
  the transitive `uuid` used by `node-jose` to `>=11.1.1` (GHSA-w5hq-g745-h8pq)
  and `brace-expansion` to `>=5.0.6` (GHSA-jxxr-4gwj-5jf2) via pnpm overrides.
  The remaining `node-kms` → `uuid@2` advisory is unreachable (bare `uuid()`
  v4-style call, no `buf` argument) and `node-kms` is pinned to that API.
- **Python: bumped crypto floors** — `cryptography>=46.0.7` (PYSEC-2026-36) and
  `jwcrypto>=1.5.7` (PYSEC-2026-70); both sit in the KMS/JWE decryption path.
- **Rust: bumped `rustls-webpki` to 0.103.13** — resolves RUSTSEC-2026-0098,
  -0099, and -0104 (name-constraint handling and a reachable CRL-parsing panic).
  Added `.cargo/audit.toml` documenting the two remaining advisories that have
  no fix and are not reachable here (`rsa` RUSTSEC-2023-0071 encrypt-only;
  `rand` RUSTSEC-2026-0097 unsound only via `rand::rng()` + custom logger, which
  this crate does not use).

## [0.6.10] - 2026-06-01

### Added
- **WDM service catalog accessors** — New read-only accessors expose the WDM
  registration the library already holds, so wrappers can make their own
  outbound calls (e.g. a Conversation-service read-receipt) using
  cluster-correct service URLs instead of hardcoding hostnames:
  `deviceRegistration()`/`serviceUrl(name)` (Node.js),
  `device_registration()`/`service_url(name)` (Python),
  `DeviceRegistration()`/`ServiceURL(name)` (Go),
  `device_registration()`/`service_url(name)` (Rust). Returned registration is
  a copy; the library remains inbound-only. (#23, all 4 languages — see
  [ADR 0001](docs/adr/0001-expose-wdm-service-catalog.md))
- **Activity `url` field** — `MercuryActivity` and `DecryptedMessage` now carry
  the Conversation-service activity `url` when Mercury includes it (needed for
  outbound `acknowledge` activities). (#23, all 4 languages)

### Fixed
- **Python: shared aiohttp connector closed on reconnect** — the native
  WebSocket adapter created its `ClientSession` without `connector_owner=False`,
  so rotating the WebSocket on reconnect closed a caller-provided shared
  connector. Every subsequent HTTP/WebSocket attempt then failed with
  "Connector is closed", causing a ~3-minute backoff storm and process restart.
  The WS adapter now mirrors the HTTP adapter's ownership logic. (#20)
- **Go: threaded-reply parent never parsed** — `parseActivity` did not read the
  raw `parent` object, so `DecryptedMessage.ParentID` and
  `AttachmentAction.MessageID` were always empty in production despite type and
  handler support. Now parsed via a `parseParent` helper.

## [0.6.9] - 2026-04-17

### Added
- **KMS circuit breaker** — After 3 consecutive KMS key fetch failures, the circuit breaker opens and fails fast (no 30s timeout stall per message). Enters half-open state after 30s cooldown to test recovery. (all 4 languages)
- **KMS key fetch retry** — Transient KMS errors (timeouts, HTTP failures) are retried once with 1s delay before failing. Permanent errors (auth, validation) fail immediately. (all 4 languages)
- **Optional timing metrics** — New `metricsCallback` / `metrics_callback` config option receives `MetricsEvent` with `connect` and `decrypt` timing data. Zero overhead when not set. (all 4 languages)
- **Delivery guarantees documentation** — New "Delivery Guarantees" section in all READMEs documenting at-most-once semantics and Mercury ACK-before-decrypt limitation.
- **Design review** — `DESIGN_REVIEW.md` evaluating the library against system design pattern rubric with actionable recommendations.

## [0.6.8] - 2026-04-13

### Fixed
- **KMS cluster URL validation** — Webex returns `kms://` scheme for `kmsCluster`, not `https://`. URL validator now accepts `kms://` for this field. Also fixed bare domain matching (`ciscospark.com` without subdomain prefix) in Node.js and Go validators. (Node.js, Go, Rust — Python was fixed in #16 by @ojaber)

### Added
- **URL validation tests** — `kms://` scheme acceptance/rejection tests for all 4 languages. New `url_validation_test.go` covering HTTPS, WSS, KMS schemes and domain validation.

## [0.6.7] - 2026-04-13

### Changed
- **README documentation** — Added v0.6.6 features (mentions, message edits, card actions, room events, files) to all 4 language READMEs with updated Quick Start examples, events tables, type definitions, and API references

## [0.6.6] - 2026-04-13

### Added
- **Mention parsing** — `parseMentions(html)` extracts `mentionedPeople` (person UUIDs) and `mentionedGroups` (e.g. `"all"`) from `<spark-mention>` tags in decrypted HTML. `DecryptedMessage` now includes both fields, populated automatically. No extra API calls. (all 4 languages)
- **Message edit event (`message:updated`)** — `verb=update` + `objectType=comment` activities route through decryption and emit `message:updated` with the same `DecryptedMessage` type as `message:created`. (all 4 languages)
- **Adaptive Card submissions (`attachmentAction:created`)** — `verb=cardAction` + `objectType=submit` activities emit `attachmentAction:created` with new `AttachmentAction` type (`id`, `messageId`, `personId`, `personEmail`, `roomId`, `inputs`, `created`, `raw`). Card data is not encrypted. (all 4 languages)
- **Room events (`room:created`, `room:updated`)** — `verb=create/update` + `objectType=conversation` activities emit room events with new `RoomActivity` type (`id`, `roomId`, `actorId`, `action`, `created`, `raw`). (all 4 languages)
- **Files field** — `MercuryObject` and `DecryptedMessage` now include `files` (string array of file URLs) when Mercury includes file attachments. (all 4 languages)

## [0.6.5] - 2026-04-13

### Added
- **Thread support (`parentId`)** — `DecryptedMessage` now includes `parentId` (the parent activity UUID) for threaded replies, parsed from the Mercury `parent` object. (all 4 languages)
- **ID conversion utilities** — `toRestId(uuid, type)` / `fromRestId(restId)` convert between Mercury activity UUIDs and Webex REST API base64-encoded IDs. Resource types: `MESSAGE`, `PEOPLE`, `ROOM`. (all 4 languages)
- **`MercuryParent` type** — new type representing the parent reference in Mercury activities (`id` + `type` fields), exported from all packages.

### Fixed
- **DecryptedMessage.id was empty** — set from `activity.id` (Mercury activity UUID) instead of `activity.object.id` which Mercury does not populate for encrypted messages. (all 4 languages)

## [0.6.3] - 2026-04-06

### Added
- **README: OAuth integration token pattern** — documented `reconnect(newToken)` usage for OAuth token refresh with `AuthError` handling examples in all four languages
- **GitHub Advanced Security** — enabled CodeQL (JS/TS, Go, Python), secret scanning with push protection, Dependabot alerts and security updates
- **MAESTRO threat model** — full 7-layer security assessment with 18 findings identified and remediated

### Security (All Languages)
- **URL validation** — validate all external API URLs (WDM, Mercury, KMS) enforce HTTPS/WSS and Webex domain allowlist
- **Bounded pending KMS requests** — cap at 100 to prevent memory exhaustion
- **Bounded key cache** — clear cache when exceeding 100 entries to prevent unbounded growth
- **Activity replay protection** — deduplicate Mercury activities by ID with 5-minute sliding window
- **Logging improvements** — include close code/reason in reconnection logs, log message deletion events

### Security (Go)
- **KMS request serialization** — mutex ensures only one KMS request in-flight, fixing FIFO ordering

### Security (Python)
- **aiohttp** 3.13.3→3.13.4 — fixes 10 HIGH-severity CVEs (DNS cache exhaustion, multipart DoS, NTLM leak)
- **cryptography** pinned >=46.0.6 — fixes 2 MEDIUM CVEs in ECDH/KMS critical path
- **KMS request serialization** — asyncio.Lock ensures request ordering

### Security (CI/CD)
- **GitHub Actions SHA-pinned** — all 17 action references pinned to commit SHAs across 3 workflows
- **SBOM generation** — CycloneDX SBOM added to publish workflow

### Fixed
- **Go: go-jose/v4** v4.0.5→v4.1.4 — fixes JWE decryption panic and DoS in parsing
- **Node.js: lodash** 4.17.23→4.18.1 — fixes code injection via `_.template` and prototype pollution via `_.unset`/`_.omit` (pnpm override for transitive dep of node-jose)

## [0.6.1] - 2026-03-28

### Fixed (All Languages)
- **ECDH remote key validation** — verify KMS returns EC P-256 key, reject invalid keys
- **WebSocket message size limit** — drop messages >1MB to prevent memory exhaustion

### Fixed (Go)
- **Handler state race conditions** — added RWMutex protecting `connected`, `connecting`, `botPersonID`, `registration`, `kmsClient`, `messageDecryptor`
- **Stack overflow in reconnect** — replaced recursive `reconnect()` with iterative loop
- **MercurySocket field races** — protected `connectionReady`, `shouldReconnect`, `reconnectAttempts` with mutex helpers
- **Activity context lifecycle** — cancelable context instead of `context.Background()`
- **gosec clean** — all G104 unhandled error findings resolved
- **Migrated websocket lib** — `nhooyr.io/websocket` → `github.com/coder/websocket`
- Upgraded go-jose v4.0.4→v4.0.5 (DoS fix), golang.org/x/crypto v0.31→v0.49

### Fixed (Python)
- **Concurrent reconnection race** — added `_reconnecting` guard flag
- **aiohttp session leak** — close `ClientSession` on WebSocket close
- **Silent async exceptions** — listener errors now logged via `add_done_callback`
- **bandit clean** — narrowed broad exceptions, replaced assert with runtime check
- **KMS queue monitoring** — warn when pending requests exceed 100

### Fixed (Node.js)
- **Pong timeout race** — clear old timeout before setting new one
- **Listener memory leak** — `removeAllListeners()` on disconnect
- **KMS FIFO safety** — serialize requests with mutex so ordering is guaranteed
- Upgraded undici 7.21→7.24.6 (HTTP smuggling, WS parser overflow, memory exhaustion)

### Fixed (Rust)
- **Connect/disconnect TOCTOU** — combined state checks into single lock acquisition
- **Dropped event logging** — warn when event channel receiver is gone
- Upgraded quinn-proto (DoS fix), rustls-webpki (CRL validation fix)
- Documented rsa Marvin side-channel as false positive (encrypt-only usage)

## [0.5.1] - 2026-03-16

### Fixed (Go)
- **Critical: nil pointer panic in ping loop during reconnection** — `pendingPongID` was accessed from multiple goroutines without mutex protection. Go strings are `(pointer, length)` headers; concurrent read/write corrupts the header, causing `==` to dereference a nil data pointer.
- `closeWebSocket` now cancels the connection context, immediately stopping stale ping loop and pong timeout goroutines
- New `triggerReconnect` guard prevents concurrent reconnection attempts (previously both the pong timeout and read loop could trigger `reconnect()` simultaneously)
- Pong timeout goroutine now respects context cancellation instead of blind `time.Sleep`

## [0.5.0] - 2026-02-12

### Added (All Languages)
- **New event: `membership:created`** — Listen for membership activities from Mercury WebSocket. Emitted when members are added/removed or moderator roles change. Single event with `action` field (`"add"`, `"leave"`, `"assignModerator"`, `"unassignModerator"`).
- New `MembershipActivity` type with fields: id, actorId, personId, roomId, action, created, roomType, raw
- Membership tests for all 4 verb variants plus negative cases in all languages

### Fixed (All Languages)
- **All lint/clippy/ruff warnings resolved** — Zero warnings across Python (ruff), Rust (clippy -D warnings), Go (vet), Node.js (eslint + tsc)
- Python: fixed long lines, unused variables, import ordering, nested if statements, contextlib.suppress usage
- Rust: fixed redundant closures, needless borrows, manual div_ceil, bool comparisons, useless conversions, large enum variants (boxed), derivable Default impls, type complexity (added type aliases)

### Changed
- **Go**: Bumped to go 1.24, replaced deprecated `elliptic.Marshal()` with `(*ecdsa.PublicKey).ECDH()`
- **Rust**: Corrected README proxy documentation — `tokio-tungstenite` does not read proxy env vars; only `reqwest::Client` routes through proxy
- **Python**: Added `trust_env=True` to native HTTP adapter for proxy env var support
- **Rust**: `MercuryEvent::Activity` now uses `Box<MercuryActivity>` to reduce enum size
- Added proxy validation and e2e test scripts for all languages

## [0.4.1] - 2026-02-12

### Fixed (All Languages)
- **Critical: Self-message filtering now works in production** — The Webex REST API (`/v1/people/me`) returns base64-encoded IDs (e.g., `ciscospark://us/PEOPLE/<uuid>`), while Mercury wire format uses raw UUIDs. The `===` comparison always failed, so `ignoreSelfMessages` never filtered anything, causing infinite message loops. Added `extractPersonUuid()` to normalize both formats to raw UUID before comparison.

### Changed (All Languages)
- **`connect()` now fails if `/people/me` is unreachable when `ignoreSelfMessages` is enabled** — Previously, failure to fetch the bot identity silently degraded to no filtering. Now `connect()` throws/returns an error, preventing the bot from running without loop protection. Set `ignoreSelfMessages: false` to opt out (not recommended).
- Updated message loop prevention tests to use realistic mismatched ID formats (base64 from REST API vs raw UUID from Mercury)
- E2E test is now bidirectional: receiver bot replies to incoming messages, verifying self-message filtering works end-to-end

### Documentation (All Languages)
- Added "Important: Implementing Loop Detection" section to all READMEs — explains that this library only sees the receive side and cannot detect send loops; recommends wrapper-level rate limiting
- Updated self-message filtering docs to describe fail-closed behavior
- Added `ignoreSelfMessages` / `ignore_self_messages` to config tables in Python, Go, and Rust READMEs

## [0.4.0] - 2026-02-12

### Breaking Changes (Node.js)
- **`agent` config field replaced with `dispatcher`** — Accepts an undici `Dispatcher` (e.g., `ProxyAgent`). A single dispatcher now proxies both HTTP fetch and WebSocket connections.
- **Node.js engine requirement raised to `>=22.4.0`** — Native `WebSocket` (stable since Node.js 22.4.0) replaces the `ws` npm package.
- **Removed `ws` dependency** — WebSocket connections now use the built-in `WebSocket` global. The `undici` package is now a production dependency (for `Dispatcher` type and `ProxyAgent` re-export).
- **Removed `@types/ws` dev dependency**

### Changed (Node.js)
- Internal WebSocket adapter wraps native `WebSocket` (EventTarget API) into `InjectedWebSocket` (.on() API), preserving the existing mercury-socket interface
- Simplified proxy support: one `ProxyAgent` handles both fetch and WebSocket in native mode

## [0.3.3] - 2026-02-11

### Changed (All Languages)
- **`ignoreSelfMessages` now defaults to `true`** — Bots automatically filter their own messages out of the box, preventing infinite response loops without any configuration
  - Set `ignoreSelfMessages: false` to opt out (e.g., for auditing)
- Added `ignoreSelfMessages` feature to Python, Go, and Rust (previously Node.js only)

### Added
- Real integration tests for message loop prevention (Node.js)

## [0.3.2] - 2026-02-11

### Added (Node.js)
- **New feature: `ignoreSelfMessages` option** - Automatically filters out messages sent by the bot to prevent infinite response loops
  - Fetches and caches bot's person ID on connection
  - Silently drops messages where personId matches the bot
  - Recommended for all bot implementations
  - Zero overhead when disabled (default)
- Comprehensive WebSocket proxy documentation for injected mode
- Example file for proxy configuration in injected mode (`examples/proxy-injected-mode.ts`)
- 14 comprehensive proxy configuration tests
- 5 tests for ignoreSelfMessages feature
- 4 message loop prevention validation tests demonstrating the infinite loop scenario

### Fixed (Node.js)
- Documented critical WebSocket proxy requirement: `ws` library needs explicit `agent` option
- Clarified difference between HTTP proxy (ProxyAgent) and WebSocket proxy (HttpsProxyAgent)

### Documentation
- Added "Preventing Message Loops" section to Node.js README
- Enhanced proxy documentation with injected mode examples
- Added warnings about WebSocket proxy bypass without proper configuration

## [0.3.1] - 2026-02-11

### Fixed
- **Node.js**: Removed unused `agent` field from handler class
- **Node.js**: Fixed type compatibility for WebSocket/InjectedWebSocket union
- **Node.js**: Improved event handler type safety
- **Rust**: Removed unused `client` variable (clean compilation, no warnings)

### Documentation
- Updated all proxy documentation to recommend undici's `ProxyAgent` for Node.js v18+
- Added notes explaining proxy compatibility with native fetch()

## [0.3.0] - 2026-02-11

### Added
- **Dependency Injection**: Full networking control via injected fetch/WebSocket factories
- **Explicit networking mode**: `mode` config field (`'native'` or `'injected'`)
- **Adapter pattern**: Internal adapters for HTTP and WebSocket operations
- **Type-safe interfaces**: `FetchRequest`, `FetchResponse`, `InjectedWebSocket`, `WebSocketFactory`
- **Construction-time validation**: Prevents conflicting mode/parameter configurations
- Comprehensive validation tests for all languages

### Changed
- Refactored DeviceManager to use HTTP adapter (3 calls)
- Refactored KmsClient to use HTTP adapter (2 calls)
- Refactored MercurySocket to accept WebSocket factory

### Documentation
- Updated README with injected mode examples
- Added API documentation for new networking types
- Enhanced proxy configuration examples

### Compatibility
- **Zero breaking changes**: Native mode behavior identical to v0.2.0
- All existing code continues to work without modifications

## [0.2.0] - Initial Release

### Added
- Mercury WebSocket connection with authentication and heartbeat
- KMS encryption/decryption support
- Device registration via WDM API
- Message event handling (created, deleted)
- Automatic reconnection with exponential backoff
- Proxy support via agent/connector parameters
- Available in 4 languages: Node.js, Python, Go, Rust

[0.5.0]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.4.1...node/v0.5.0
[0.4.1]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.4.0...node/v0.4.1
[0.4.0]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.3.3...node/v0.4.0
[0.3.3]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.3.2...node/v0.3.3
[0.3.2]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.3.1...node/v0.3.2
[0.3.1]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.3.0...node/v0.3.1
[0.3.0]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.2.0...node/v0.3.0
[0.2.0]: https://github.com/3rg0n/webex-message-handler/releases/tag/node/v0.2.0
