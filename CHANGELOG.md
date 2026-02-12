# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
