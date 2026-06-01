# 0001. Expose WDM service catalog and activity URL for outbound-capable wrappers

- Status: accepted
- Date: 2026-06-01

## Context

The library is deliberately **inbound-only**: it registers a device with WDM,
connects Mercury, decrypts activities, and emits them. Outbound calls (sending
messages, read-receipts) are the wrapper's job — which is why `toRestId` /
`fromRestId` are provided as a hand-off.

A downstream consumer (`mythingies/plugin-webex`) wants a "peek → triage → take
action → mark read" flow where a Conversation-service `acknowledge` activity
(the read-receipt) fires only on real action. To make that outbound call the
wrapper needs:

1. The **conversation-service base URL**, which lives in the WDM service catalog
   the library already fetches at connect time and stores internally. The Webex
   JS SDK resolves outbound URLs the same way. Without an accessor the wrapper
   would hardcode `conv-a.wbx2.com`, which is brittle across clusters and orgs.
2. The **activity `url`** — the `acknowledge` object wants `{id, url}`. Mercury
   includes a top-level `url` on conversation activities, but the library was
   discarding it.

See GitHub issue #23. (Issue #22 wrongly proposed putting the outbound call in
this library; this decision supersedes that approach.)

## Decision

Expose the already-held data **read-only**, without adding any outbound code
paths, dependencies, or a Conversation-API client:

- **`deviceRegistration()` / `device_registration()` / `DeviceRegistration()`**
  — returns a copy of the WDM registration (including the `services` catalog),
  or null/None before connect. The copy is isolated: mutating it does not affect
  internal handler state.
- **`serviceUrl(name)` / `service_url(name)` / `ServiceURL(name)`** — narrow
  accessor returning a single catalog URL by key.
- **`url` field** on `MercuryActivity` and `DecryptedMessage` — parsed from the
  raw Mercury activity when present, empty/None otherwise.

Implemented across all four languages (Node.js, Python, Go, Rust) for parity.

## Consequences

- Wrappers can perform outbound Conversation-service calls (read-receipts, etc.)
  using cluster-correct URLs discovered at runtime, instead of hardcoding hosts.
- The library's public contract grows by two accessors and one field per
  language. These are additive and read-only — no breaking changes.
- The library remains inbound-only; the trust/security boundary is unchanged
  (no new network egress originates here).
- Returned registration values are copies, so callers cannot corrupt internal
  state by mutating them.
