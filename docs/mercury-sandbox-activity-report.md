# Mercury WebSocket delivers no `conversation.activity` in a developer sandbox org (works in production)

**Date:** 2026-07-18
**Reporter:** Ergon Copeland (ecopelan@cisco.com)
**Severity:** High for anyone building a Mercury-based receive client against a sandbox org — the socket is fully healthy but delivers zero live messages.

---

> ## ✅ RESOLVED (2026-07-21) — root cause was client-side region registration
> Webex Engineering identified it: the sandbox org's WDM service maps to
> **`wdm-r.wbx2.com`**, but the library hard-coded **`wdm-a.wbx2.com`** and did
> no service discovery. Registering a device in the wrong region yields a socket
> that authorizes + completes KMS but never receives that org's
> `conversation.activity`. (Production worked only because that org maps to `-a`.)
>
> **Fix:** discover the org-correct WDM base from U2C
> (`GET https://u2c.wbx2.com/u2c/api/v1/catalog?format=hostmap` → `serviceLinks.wdm`)
> before registering; fall back to `wdm-a` only if discovery fails. Verified in
> the previously-failing sandbox: registers `wdm-r`, connects to the `-r` Mercury
> region, and receives all messages (3/3). Shipped in all 4 languages. The
> analysis below is retained for the record.

---

## Summary

A Mercury WebSocket that **connects, authorizes, and completes the KMS handshake** in a Webex **developer sandbox org** receives the connect-time buffer state and KMS messages, and then **only ping/pong frames** — **no `conversation.activity` events are ever delivered**. Messages posted live to a room the account belongs to never reach the socket, even though the same messages are immediately visible via the REST API (`GET /v1/messages`).

The **identical client code, against a production org, works perfectly** — `conversation.activity` frames arrive live for every message. This isolates the problem to Mercury's live-activity routing for the sandbox org, not to any client implementation.

We reproduced the sandbox failure with **three independent clients** (including the official Webex JS SDK), which rules out a bug in any one library, and with **two different sandbox observer accounts**, which rules out an account-specific condition.

---

## Environments

| | Sandbox (fails) | Production (works) |
|---|---|---|
| Org domain | `anbeasle-7xgm.wbx.ai` (developer sandbox) | `cisco.com` |
| Observer account | `signalstack@anbeasle-7xgm.wbx.ai` (type: **person**) | `ecopelan@cisco.com` (type: **person**) |
| Sender | real user (`ecopelan@anbeasle-7xgm.wbx.ai`) | bot (`Temp.bot@webex.bot`) |
| Mercury host | `mercury-connection-partition0-a.wbx2.com` | `mercury-connection-partition2-a.wbx2.com` |
| WDM registration | ✅ HTTP 200, valid `webSocketUrl`, 38 services | ✅ HTTP 200 |
| Socket authorize (`mercury.buffer_state`) | ✅ | ✅ |
| KMS handshake (`encryption.kms_message`) | ✅ | ✅ |
| **Live `conversation.activity`** | ❌ **never delivered** | ✅ **delivered for every message** |

Both accounts are `type: person` and confirmed members of the target room in each environment. Org IDs available on request.

### Failure is org-wide, not account-specific

To rule out an account-level condition, we re-ran the sandbox test with the roles reversed — a **second, different** sandbox person account as the observer, and SignalStack as the sender:

| Test | Observer (listens) | Sender | Result |
|---|---|---|---|
| Sandbox A | `signalstack@anbeasle-7xgm.wbx.ai` | `ecopelan@anbeasle-7xgm.wbx.ai` | ❌ 0/3 silent |
| Sandbox B (roles flipped) | `ecopelan@anbeasle-7xgm.wbx.ai` | `signalstack@anbeasle-7xgm.wbx.ai` | ❌ 0/3 silent |
| Production | `ecopelan@cisco.com` | `Temp.bot@webex.bot` | ✅ 3/3 received |

Both distinct sandbox accounts fail as observers; the production account succeeds. This confirms the condition is **the sandbox org's Mercury deployment**, not any individual account, token, sender, or room.

---

## Symptom (sandbox)

On connect, the socket does everything correctly:

```
Connecting to Mercury at wss://mercury-connection-partition0-a.wbx2.com/v1/apps/wx2/registrations/<reg-id>/messages?aliasHttpStatus=true&bufferStates=true&clientTimestamp=<ts>&outboundWireFormat=text
WebSocket opened, sending authorization
Mercury eventType: mercury.buffer_state        <-- authorization acknowledged
Mercury eventType: encryption.kms_message      <-- KMS handshake delivered
OBSERVER connected
observer status: wsOpen=true device=true kms=true
```

Then, for the entire session, **only** ping/pong frames. A message posted live to a room the account is a member of produces **no** `conversation.activity` frame. Across a full session only two event types are ever seen: `mercury.buffer_state` and `encryption.kms_message`.

Round-trip test (post via REST → observe via Mercury), sandbox:

```
OUTBOUND posted "roundtrip 1" — waiting up to 12s for observer to receive…
ROUNDTRIP 1: ✗ observer did NOT receive the message (silent delivery)
ROUNDTRIP 2: ✗ observer did NOT receive the message (silent delivery)
ROUNDTRIP 3: ✗ observer did NOT receive the message (silent delivery)
```

The **same test in production** (bot posts, person observes):

```
Mercury eventType: conversation.activity
Mercury eventType: apheleia.subscription_update     <-- never seen in sandbox
INBOUND membership room=… person=ecopelan@cisco.com action=add
OUTBOUND posted "roundtrip 1" — waiting up to 12s for observer to receive…
Mercury eventType: conversation.activity
INBOUND message from=Temp.bot@webex.bot text="roundtrip 1"
ROUNDTRIP 1: ✓ observer received the message
ROUNDTRIP 2: ✓ observer received the message
ROUNDTRIP 3: ✓ observer received the message
```

Note production also emits `apheleia.subscription_update` and membership activities that the sandbox connection never sends — suggesting the sandbox connection is subscribed to a narrower set of event classes (or none of the conversation stream).

---

## What has been ruled out

- **Client / library bug** — reproduced with three independent implementations (see below), including the official Webex JS SDK.
- **Auth frame format** — auth succeeds (`mercury.buffer_state` returns). The frame sends `{id, type:"authorization", data:{token:"Bearer <token>"}}`, matching the JS SDK's `token.toString()` (which is `"Bearer <token>"`). Sending a raw (non-`Bearer`) token instead makes it **worse** (socket closes during setup), confirming `Bearer` is what Mercury accepts.
- **WebSocket upgrade auth** — also tried presenting `Authorization: Bearer <token>` on the WS upgrade request (in addition to the in-band auth frame): no change in the sandbox.
- **URL params** — `outboundWireFormat=text&bufferStates=true&aliasHttpStatus=true` match the JS SDK's non-`web-shared-mercury` default exactly.
- **Device registration** — full-body `POST /wdm/api/v1/devices?includeUpstreamServices=all` returns HTTP 200 with a valid `webSocketUrl` and a 38-entry service catalog. Reproduced with exactly **one** clean device (device count verified at 0 beforehand), so this is not a per-user device-cap issue.
- **KMS** — `encryption.kms_message` is received and routed correctly.
- **Room membership / visibility** — the observer is a confirmed member, and **all** the test messages are readable by the observer via `GET /v1/messages?roomId=…` immediately after posting. REST delivery works; only Mercury real-time delivery is silent.
- **Token type** — the sandbox observer is a `type: person` account, so "bots only receive @mentions in group spaces" does not apply.

---

## Reproduction across three independent clients (all fail in the sandbox)

| Client | Language / SDK | WDM registration | Socket auth + KMS | Live `conversation.activity` |
|---|---|---|---|---|
| webex-message-handler | Go (custom Mercury impl) | ✅ 200 | ✅ authorizes, KMS ok | ❌ 0/3 (silent) |
| [WebexCommunity/webex-go-sdk](https://github.com/WebexCommunity/webex-go-sdk) | Go | ✅ (registered device) | reached Mercury connect | ❌ never delivered |
| [Hookbuster](https://github.com/WebexSamples/hookbuster) → official **Webex JS SDK** (`webex-node`) | Node.js | authenticated `/people/me` | `messages.listen()` did not complete | ❌ never delivered |

The same three clients receive messages normally in a production org.

---

## Questions for the Webex team

1. Is `conversation.activity` delivery over Mercury **expected to work in developer sandbox orgs** (e.g. `*.wbx.ai`), or is the sandbox Mercury deployment intentionally limited to buffer-state + KMS frames?
2. If it is expected to work, is there a **registration flag, feature toggle, or service association** that a sandbox device/socket needs in order to be subscribed to the conversation activity stream? Production connections emit `apheleia.subscription_update`; sandbox connections do not — is that the differentiator, and is it client-triggerable?
3. Is there anything about how the **sandbox org itself is provisioned** (features/entitlements) that would gate real-time conversation delivery while leaving REST and the KMS/buffer path intact?

We can provide org IDs, device registration IDs, Mercury `webSocketUrl`s, and full frame logs with `trackingId`s for both environments on request.

---

## Environment details for correlation

- Sandbox Mercury registration path observed: `wss://mercury-connection-partition0-a.wbx2.com/v1/apps/wx2/registrations/<reg-id>/messages`
- Production Mercury registration path observed: `wss://mercury-connection-partition2-a.wbx2.com/v1/apps/wx2/registrations/<reg-id>/messages`
- WDM endpoint: `https://wdm-a.wbx2.com/wdm/api/v1/devices`
- Device body used (registers successfully, HTTP 200): `deviceType: "DESKTOP"`, `name/deviceName: "webex-message-handler"`, plus `model`, `localizedModel`, `systemName`, `systemVersion`.

*(Sandbox `trackingId`s from failing sessions and the exact registration IDs are available; omitted here to keep the report shareable.)*
