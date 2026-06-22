# Contributing to webex-message-handler

Thanks for your interest in contributing! This monorepo contains four language implementations of the same library, so contributions can range from fixing a bug in one language to adding a feature across all four.

## Repository Structure

```
node/       # TypeScript/Node.js implementation
python/     # Python implementation
go/         # Go implementation
rust/       # Rust implementation
```

Each language directory is self-contained with its own README, API docs, tests, and build configuration.

## Getting Started

### Prerequisites

- **Node.js**: Node.js 24+ (LTS) and pnpm
- **Python**: Python 3.10+ and pip
- **Go**: Go 1.26.4+
- **Rust**: Rust 1.75+ (via rustup)

### Setup

Clone the repo and install dependencies for the language(s) you want to work on:

```bash
# Node.js
cd node && pnpm install

# Python
cd python && pip install -e ".[dev]"

# Go
cd go && go mod download

# Rust
cd rust && cargo build
```

### Running Tests

```bash
# Node.js
cd node && pnpm test

# Python
cd python && python -m pytest tests/ -v

# Go
cd go && go test ./... -v

# Rust
cd rust && cargo test
```

## Making Changes

### Bug Fixes

If a bug exists in one language, check whether the same bug exists in the other implementations. If it does, fix it across all affected languages in the same PR.

### New Features

New features should ideally be implemented across all four languages to keep them in sync. If you only know one language, that's fine — open the PR for that language and note in the description that the other languages need the same change.

### Code Style

Follow the idiomatic conventions for each language:

- **Node.js**: ESLint configuration in `node/.eslintrc.cjs`
- **Python**: PEP 8, type hints, snake_case
- **Go**: `gofmt`, `go vet`, exported types documented
- **Rust**: `cargo fmt`, `cargo clippy`, idiomatic error handling with `thiserror`

## Pull Request Process

1. Fork the repo and create a branch from `master`
2. Make your changes and ensure tests pass for all affected languages
3. Update API.md if you changed the public API
4. Open a PR with a clear description of what changed and why

## Testing with a Live Bot

To run live integration tests, you need a Webex bot token. Set it in a `.env` file at the repo root:

```
WEBEX_BOT_TOKEN=your_token_here
```

Each language's example bot can be run to verify end-to-end functionality:

```bash
# Node.js
cd node && npx tsx examples/basic-bot.ts

# Python
cd python && python examples/basic_bot.py

# Go
cd go && go run examples/basic-bot/main.go

# Rust
cd rust && cargo run --example basic_bot
```

## Reporting Issues

Open an issue with:
- Which language implementation is affected
- Steps to reproduce
- Expected vs actual behavior
- Webex API error codes if applicable (redact tokens)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
