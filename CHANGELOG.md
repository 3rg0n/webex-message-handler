# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.2]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.3.1...node/v0.3.2
[0.3.1]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.3.0...node/v0.3.1
[0.3.0]: https://github.com/3rg0n/webex-message-handler/compare/node/v0.2.0...node/v0.3.0
[0.2.0]: https://github.com/3rg0n/webex-message-handler/releases/tag/node/v0.2.0
