# ADR-0073: Web Push (VAPID) as the Overdue-nudge transport

- Status: Accepted
- Date: 2026-05-21
- Refines: ADR-0061 (DO hibernating WebSocket projection feed)
- Companion: [ADR-0072](./0072-overdue-state-and-nudge-loop.md), [ADR-0074](./0074-push-subscription-anonymity.md)

## Decision

Adopt the [Web Push protocol](https://datatracker.ietf.org/doc/html/rfc8030)
with VAPID ([RFC 8292](https://datatracker.ietf.org/doc/html/rfc8292))
and `aes128gcm` payload encryption
([RFC 8291](https://datatracker.ietf.org/doc/html/rfc8291)) as the
canonical transport for ADR-0072's Overdue nudge loop.

A new `packages/push` workspace package owns:

- `vapid.ts` — `ES256` JWT signing with `crypto.subtle` (P-256 ECDSA)
- `payload.ts` — RFC 8291 (aes128gcm) content encoding: ephemeral
  P-256 ECDH + HKDF-SHA256 + AES-128-GCM
- `client.ts` — push-service `POST` with `Authorization: vapid` +
  `Crypto-Key` headers; treats `404` / `410` as subscription
  invalidation and surfaces it to the caller

The npm `web-push` library is **not** adopted because its Node-only
crypto bindings (`crypto.createHash`, `Buffer`, the `http` module)
do not run on the Cloudflare Workers runtime (ADR-0015 keeps the
production target Workers-shaped).

Phase 1 (per ADR-0072) ships with `channel: "ws"` nudges over the
existing hibernating-WebSocket feed; Phase 2 (this ADR) flips the
default `channel` to `"push"` once a subscription is registered for
the ticket.

## Context

ADR-0072 introduced a nudge loop that needs to reach the customer
when they have closed the `/ticket` tab. WebSocket broadcasts
(ADR-0061) only reach open tabs; OS-level notifications via the
browser Notification API silently no-op when the page is not
focused. The OS-level push channel (Web Push) is the only path that
reaches the user when the page is unloaded.

The Workers runtime constraint shapes the implementation:

- `crypto.subtle` is available; the `node:crypto` module is not.
- No `Buffer`; `Uint8Array` / `TextEncoder` / `atob`-style base64
  manipulation only.
- Outbound `fetch` to push services
  (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, etc.)
  is allowed.

The `web-push` npm package leans on `Buffer.concat`, the `https`
core module, and `crypto.createHmac`. Patching it to run on Workers
is impractical; a focused 200-line implementation is cleaner.

## Trade-offs

| | npm `web-push` | **WebCrypto self-impl** | Email / SMS gateway |
|--|--|--|--|
| Runs on Workers | no (Node bindings) | **yes** | yes (via 3rd-party API) |
| Cost surface | npm dep + audit | code we own | service contract + per-message fee |
| Anonymity (ADR-0054) | opaque endpoint OK | opaque endpoint OK | breaks (email / phone are PII) |
| OS-level reach on closed tab | yes | yes | yes (email) / yes (SMS) |
| Maintenance | upstream rev | we own the crypto | vendor lock |
| Subscription lifecycle | client-handled | client-handled (we own the 410 sweep) | n/a |

The self-implementation wins on Workers compatibility (the only
production target) and anonymity (ADR-0054 hard requirement). The
WebCrypto API is stable; the protocol RFCs are static; the
maintenance surface is bounded.

## Implementation

### `packages/push/src/vapid.ts`

```ts
type VapidKeyPair = {
  readonly publicKeyBase64Url: string   // raw 65-byte uncompressed P-256
  readonly privateKeyBase64Url: string  // raw 32-byte scalar
}

export const signVapidJwt = (
  audience: string,
  subject: string,            // `mailto:...` or `https://...`
  privateKeyBase64Url: string,
  expirySeconds: number = 12 * 60 * 60,
): Promise<string>
```

- Decode the 32-byte private scalar to a JWK and import as
  `ECDSA / P-256 / sign`.
- Build the JWT header `{"typ":"JWT","alg":"ES256"}` (base64url).
- Build the payload `{aud, exp: now + expirySeconds, sub}` (base64url).
- Sign `${header}.${payload}` with `crypto.subtle.sign({name:"ECDSA",
  hash:"SHA-256"}, key, data)`.
- Concatenate `${header}.${payload}.${base64url(sig)}`.

### `packages/push/src/payload.ts`

Implements RFC 8291 §3 `aes128gcm` content encoding:

```ts
export type ClientPublicKey = {
  readonly p256dh: string  // base64url; client's static ECDH public key
  readonly auth: string    // base64url; 16-byte client auth secret
}

export const encryptPayload = (
  plaintext: Uint8Array,
  client: ClientPublicKey,
): Promise<Uint8Array>  // RFC 8291 §3 framed record
```

- Generate ephemeral P-256 ECDH key pair on Workers.
- ECDH: `derive(ephemeralPriv, clientP256dh) → sharedSecret`.
- PRK from `sharedSecret + clientAuth` via HKDF-SHA256
  (info = `"WebPush: info\0" || clientP256dh || ephemeralPub`).
- CEK from `PRK + salt + info=Content-Encoding: aes128gcm\0`
  via HKDF-SHA256 → 16-byte AES-GCM key.
- NONCE from `PRK + salt + info=Content-Encoding: nonce\0`
  via HKDF-SHA256 → 12-byte IV.
- Encrypt `plaintext || 0x02 || padding` with AES-GCM (16-byte tag).
- Frame: `salt(16) || rs(4)=4096 || idlen(1) || keyid(idlen) || ciphertext`.

### `packages/push/src/client.ts`

```ts
export type PushSubscription = {
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
}

export const sendPush = (params: {
  readonly subscription: PushSubscription
  readonly payload: Uint8Array     // anonymous; ADR-0074
  readonly vapidPublicKeyBase64Url: string
  readonly vapidPrivateKeyBase64Url: string
  readonly subject: string         // `mailto:ops@...`
  readonly ttl?: number            // seconds the push service buffers
}): Promise<SendPushResult>

export type SendPushResult =
  | { readonly kind: "delivered"; readonly status: number }
  | { readonly kind: "subscriptionGone"; readonly status: 404 | 410 }
  | { readonly kind: "rejected"; readonly status: number; readonly body: string }
  | { readonly kind: "transportError"; readonly cause: unknown }
```

- Builds the VAPID JWT for the subscription endpoint's origin
  (`new URL(endpoint).origin`) as the `aud` claim.
- Encrypts the payload via `encryptPayload`.
- POST with headers:
  - `Authorization: vapid t=<JWT>, k=<vapidPubBase64Url>`
  - `Content-Encoding: aes128gcm`
  - `TTL: <ttl ?? 60>`
  - `Content-Type: application/octet-stream`
- 404 / 410 → `kind: "subscriptionGone"`. Caller is expected to
  delete the row.

### Effect port

```ts
export interface PushChannelOps {
  readonly send: (s: PushSubscription, payload: Uint8Array) => Effect.Effect<SendPushResult>
}
export class PushChannel extends Context.Tag("PushChannel")<PushChannel, PushChannelOps>() {}
```

A `WebCryptoPushChannelLive` layer composes `signVapidJwt` +
`encryptPayload` + `fetch`. Tests use an `InMemoryPushChannelLive`
that records calls without any network I/O.

### Failure modes

- **404 / 410 (subscription invalidated)**: surface as
  `subscriptionGone`; the caller (the `Nudge` use case dispatcher in
  `QueueShop.alarm()`) deletes the matching row from
  `push_subscriptions`. The alarm's next fire skips the ticket
  because its subscription set is empty.
- **413 (payload too large)**: never occurs in production
  because our payloads are kept under 64 bytes (ADR-0074); surfaces
  as `rejected` if it ever does.
- **5xx (push service outage)**: surfaces as `rejected`; the alarm
  records the event but does not retry within the same tick. The
  next nudge interval re-attempts.
- **DNS / TLS failure**: surfaces as `transportError`.

### Phase transition (Phase 1 → Phase 2)

The `Nudge` use case (`packages/core`) accepts `channel: "ws" | "push"`
already (per ADR-0072). The QueueShop alarm's Tick 2 reads
`push_subscriptions` for the ticket:

- 0 rows → dispatch `Nudge(channel: "ws")` (broadcast-only, as in
  Phase 1).
- ≥ 1 row → dispatch one `Nudge(channel: "push")` per subscription,
  followed by one broadcast (so an open tab also chimes).

No core-code behavioural change is required; the integration lives
entirely in `apps/default`.

## Consequences

- A new outbound network dependency: `fcm.googleapis.com` for
  Chrome / Edge, `updates.push.services.mozilla.com` for Firefox,
  `web.push.apple.com` for Safari (16.4+). All three are reachable
  from Cloudflare Workers.
- The VAPID key pair lives in Worker secrets (`VAPID_PRIVATE_KEY`)
  and Pages env (`VITE_VAPID_PUBLIC_KEY`). Rotation is a config
  change + a re-subscribe drive (clients re-fetch the public key on
  /ticket mount and update their stored subscription if it
  differs).
- A subscription row is created on the customer's first /ticket
  mount **after they grant Notification permission**. Customers who
  decline permission fall back to Phase 1 behaviour (WebSocket-only
  nudges).
- iOS Safari requires the page to be installed as a PWA before push
  works (Apple's policy). Customers on iOS see the WS-only flow
  until they "Add to Home Screen".

## Alternatives considered

- **`web-push` npm package**: rejected; Node-only crypto bindings,
  see Context.
- **`@negrel/webpush` (Deno)**: rejected; targets Deno's standard
  crypto, not WebCrypto SubtleCrypto; the Workers runtime would
  reject the import paths.
- **Email / SMS gateway**: rejected; breaks ADR-0054 anonymity
  (customer email or phone number would become persistent PII).
- **Polling from the client**: rejected; defeats the purpose
  (closed tab cannot poll).
- **Custom websocket reconnect-and-buffer**: rejected; the page
  cannot keep a websocket alive when unloaded — push is the only
  primitive that works.

## References

- [RFC 8030 — Generic Event Delivery Using HTTP Push](https://datatracker.ietf.org/doc/html/rfc8030)
- [RFC 8291 — Message Encryption for Web Push](https://datatracker.ietf.org/doc/html/rfc8291)
- [RFC 8292 — VAPID for Web Push](https://datatracker.ietf.org/doc/html/rfc8292)
- Plan: `/home/yasunobu/.claude/plans/queue-radiant-harp.md`
- Companion ADR-0072 — Overdue nudge loop.
- Companion ADR-0074 — Push subscription anonymity.
