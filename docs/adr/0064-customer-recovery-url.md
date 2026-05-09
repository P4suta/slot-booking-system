# ADR-0064: Customer recovery URL (canonical / cache layering / share-safety)

- Status: Accepted
- Date: 2026-05-09
- Refines: ADR-0054 (anonymous customer handle)

## Decision

The customer's ticket page has a **canonical recovery URL** of the
form

```
/ticket?id={ticketId}&k={nameKana}&p={phoneLast4}
```

`sessionStorage` becomes a **cache** of that URL's parameters,
not the source of truth. A reload, a tab close, or a different
device all converge on the same view by replaying the URL.

A separate **share-safe** entry point lives at
`/recover?id={ticketId}` — only the ticket id travels in the
URL, and the page prompts for `nameKana + phoneLast4` before
calling `GET /api/v1/tickets/me`. Operators print / display
this short form when handing a paper QR to the customer.

The QR code on `/ticket` encodes the **full canonical URL**
(`?id&k&p`). Sharing it is sharing the credential — the customer
is intentionally giving the recipient access to their ticket
view, the same as handing over the paper number.

## Context

ADR-0054 introduced the anonymous customer handle
(`nameKana + phoneLast4 + ticketId`) and made the front-end
hold the handle in `sessionStorage` after issue. That works for
the same browser tab session but fails three operationally
common cases:

1. The customer issues on a friend's phone, then opens their
   own phone to follow.
2. The customer has the queue tab open, accidentally closes it,
   and re-types the URL.
3. The customer clears site data mid-wait.

Each case forces the customer to re-enter the handle from
scratch — there is no persistence the customer themselves can
trigger.

## Trade-offs

| | sessionStorage only | URL fragment `#id` | **canonical URL** | full account |
|--|--|--|--|--|
| Reload survives | no | id only, no handle | yes | yes |
| Other-device | no | no | yes | yes |
| Share via QR | no | id only | yes | account flow |
| Server change | none | none | none | session/cookie/D1 schema |
| PII in URL bar | no | no | **yes (kana visible)** | no |
| PII in browser history | no | id only | **yes** | no |

The canonical URL deliberately accepts the PII-in-URL trade-off:
the customer is not signed in, ADR-0054 keeps every customer
anonymous to the back-end, and the kana that appears in the URL
bar is the same kana the customer just typed into the form. The
share-safe `/recover?id` path exists for the case where the URL
bar is exposed to a third party (showing the QR to a friend).

## Implementation

- `apps/web/src/routes/ticket/+page.svelte` reads `id`, `k`,
  `p` from `$page.url.searchParams` first; `sessionStorage` is
  read only as a cache when query params are absent (for the
  legacy `#id` URL form). `sessionStorage` is written after
  every successful `myTicket()` round-trip so the next reload
  sees the latest server-canonical handle (PII normalised).
- `apps/web/src/routes/recover/+page.svelte` (new) accepts
  `id` from the query string, prompts for kana + last4 in a
  form, and on submit either:
  - redirects to `/ticket?id&k&p` if `myTicket()` returns 200,
  - or surfaces the standard `PhoneMismatch` 403 error card.
- `apps/web/src/lib/qr.ts` (new) wraps the
  [`qrcode`](https://www.npmjs.com/package/qrcode) library with
  a typed `encodeRecoveryUrl(ticketId, kana, phoneLast4)` that
  builds the canonical URL and returns a data-URL PNG.
- `/issue` writes the issued ticket's canonical URL to
  `sessionStorage` and redirects with the canonical URL itself
  (not the legacy `#id` form). The `#id` form continues to be
  understood for backward compatibility for one release cycle.

## Consequences

- The customer's URL bar displays kana + phone-last-4. We
  consider the latter low-risk (not enough to identify a person
  by itself) and the former equivalent to printing the kana on
  a paper number — the operator already prints both today.
- The browser's history contains the URL. Customers who care
  can use `/recover?id=…` and re-type the handle on each
  device.
- `GET /api/v1/tickets/me` is unchanged. Its rate limit + the
  3-tuple match (timing-safe) make brute force on the kana /
  last-4 expensive even when `id` is known.
- The web search-engine indexing is mitigated by the fact that
  ticket ids are TypeID-shaped (`tkt_<26-char-ULID>`) and
  not enumerable from outside; the `meta name="robots"` of
  `/ticket` is set to `noindex` to be defensive.
