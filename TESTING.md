# Integration Testing

This document describes how to run integration tests that verify the full message pipeline using a live Webex bot.

## Overview

Integration tests verify the complete flow:
1. **Device registration** (WDM)
2. **Mercury WebSocket connection**
3. **KMS initialization** (ECDH handshake)
4. **Message send** (REST API)
5. **Message receive** (Mercury WebSocket)
6. **Message decryption** (KMS)

The test sends a message to the bot's own email address, creating a 1:1 space where the bot receives its own messages.

## Prerequisites

You need a Webex bot access token. You can:
- Use an existing bot token
- Create a dedicated test bot at https://developer.webex.com/my-apps

**Recommended:** Create a separate test bot (e.g., "OKR Atlas - Tester") to avoid conflicts with production bots.

## Setting Up GitHub Secrets (for CI/CD)

### Using `gh` CLI (Recommended)

```bash
# Set the bot token secret
gh secret set WEBEX_BOT_TOKEN

# You'll be prompted to enter the token (hidden input):
# ? Paste your secret ***********************************
# ✓ Set Actions secret WEBEX_BOT_TOKEN

# Or pipe from environment variable:
gh secret set WEBEX_BOT_TOKEN --body "$WEBEX_BOT_TOKEN"

# Later, when you create a dedicated test bot:
gh secret set WEBEX_TEST_BOT_TOKEN --body "$WEBEX_TEST_BOT_TOKEN"

# List all secrets:
gh secret list

# Remove a secret:
gh secret remove WEBEX_BOT_TOKEN
```

### Using GitHub Web UI

1. Go to repository Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `WEBEX_BOT_TOKEN`
4. Value: Your bot access token
5. Click "Add secret"

## Running Tests Locally

### Node.js

```bash
cd node
pnpm install
pnpm run build

# Run integration test
WEBEX_BOT_TOKEN=your_token node test/integration.test.js
```

### Python

```bash
cd python
pip install -e .
pip install pytest pytest-asyncio aiohttp

# Run integration test
WEBEX_BOT_TOKEN=your_token pytest tests/test_integration.py -v
```

### Go

```bash
cd go
go mod download

# Run integration test
WEBEX_BOT_TOKEN=your_token go test -v -run TestIntegration
```

### Rust

```bash
cd rust

# Run integration test (note the --ignored flag)
WEBEX_BOT_TOKEN=your_token cargo test --test live_integration_test -- --ignored --nocapture
```

## Running Tests in CI/CD

Integration tests are configured to run:

1. **Manually** - via GitHub Actions workflow dispatch
2. **Daily** - scheduled at noon UTC to verify bot health
3. **On PR** - when PR is labeled with `test:integration`

### Manual Trigger

```bash
# Trigger all integration tests
gh workflow run integration-tests.yml

# View workflow runs
gh run list --workflow=integration-tests.yml

# Watch a specific run
gh run watch
```

### PR Label Trigger

Add the label `test:integration` to a pull request to run integration tests:

```bash
gh pr edit <pr-number> --add-label "test:integration"
```

## Test Output

Successful test output looks like:

```
🚀 Starting integration test...

1️⃣  Connecting to Mercury...
✅ Connected to Mercury
2️⃣  Fetching bot identity...
   Bot: OKR Atlas - Tester (okr-atlas-tester@webex.bot)
3️⃣  Sending test message: "Integration test 1707234567890"
   Message sent (ID: Y2lzY29zcGFyazovL3VzL01FU1NBR0UvYzBkNGU4...)
4️⃣  Waiting for message to arrive via Mercury...
📨 Received message: "Integration test 1707234567890" from okr-atlas-tester@webex.bot

📊 Test Results:
✅ PASSED - Message received and decrypted successfully
   Expected: "Integration test 1707234567890"
   Received: "Integration test 1707234567890"

🧹 Cleaning up...
✅ Disconnected

✅ Integration test completed successfully
```

## Troubleshooting

### Test times out

- Verify bot token is valid
- Check network/firewall allows WebSocket connections
- Ensure bot has not been rate-limited

### Bot doesn't receive message

- Verify bot can send messages to itself (check in Webex app)
- Check bot has messaging permissions
- Ensure 1:1 space was created (check via Webex API)

### Authentication fails

- Verify token is not expired
- Check token has correct scopes (`spark:all` or `spark:messages_read` + `spark:messages_write`)
- Regenerate bot token if needed

## Security Notes

- **Never commit tokens** to the repository
- Use GitHub Secrets for CI/CD
- Use environment variables for local testing
- Consider using a dedicated test bot separate from production
- Rotate tokens periodically
- Review audit logs for unexpected test runs

## Future Improvements

When ready, create a dedicated test bot:
1. Create new bot at https://developer.webex.com/my-apps
2. Name it something like "OKR Atlas - Tester"
3. Add token as `WEBEX_TEST_BOT_TOKEN` secret
4. Update workflows to use test bot token
5. Keep production bot token separate
