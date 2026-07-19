# ADR 0005: Serialize Chrome AI across side-panel documents

## Context

ADR 0002 places Chrome Prompt API execution in the side-panel document because
the API is unavailable in the Manifest V3 service worker. Chrome can keep more
than one TabKebab side-panel document open, including panels in different
browser windows. Each document has its own JavaScript realm and runtime port.

A newer panel can replace the worker's current port while an older panel is
still destroying a Prompt API session. The current port can also disappear
before it can acknowledge that cleanup. Activating another document at that
point can overlap providers, while forgetting the older live port can leave an
open panel unable to serve later work.

The [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
coordinates asynchronous work across same-origin documents and workers. Locks
are released after the request callback settles or when its execution context
terminates.

## Decision

The service-worker broker client registers every live named Chrome AI port with
a monotonically increasing sequence. The newest connection owns requests;
older connected ports remain ordered standbys. Ordinary replacement with
pending work cancels and drains the current generation before promotion. If the
owner transport disappears, that generation rejects and the newest live
standby is promoted immediately. Exact port records and generations isolate
stale results and disconnects.

Each side-panel broker acquires the extension-origin exclusive Web Lock named
`tabkebab:chrome-ai-provider` before constructing a provider. It holds that lock
through the awaited provider method and its cleanup. Cancellation while queued
aborts the lock request without constructing a provider. Cancellation while
holding the lock keeps it until provider settlement. If Web Locks is absent,
Chrome AI fails closed with a typed unavailable result before provider
construction; there is no unlocked or realm-local fallback.

This coordination uses no additional runtime-port envelope. Worker-to-panel
traffic remains the request/cancel protocol defined by ADR 0002 and the shared
protocol validator.

## Alternatives rejected

- **Use a module-local promise mutex:** each side-panel document has a separate
  realm, so two panels would acquire unrelated mutexes and could still overlap.
- **Disconnect every demoted panel:** its broker would reconnect and become the
  newest connection again, causing ownership churn; closing the replacement
  could also leave another open panel stranded.
- **Wait only for a terminal port message:** a severed port cannot acknowledge
  cleanup, so failover would either wait forever or start unsafely.
- **Add owner/standby control envelopes:** the worker already knows live-port
  membership and is the only request sender. Another protocol adds races and
  validation surface without improving ownership authority.
- **Use an offscreen or singleton hidden document:** ADR 0002 rejects the
  undocumented Prompt API/offscreen combination, and adding another document
  lifecycle would expand permissions and failure modes.
- **Allow concurrent Prompt sessions across documents:** this preserves more
  throughput but violates cleanup-before-retry/failover guarantees and makes
  maximum active resource use dependent on panel count.

## Consequences

- At most one TabKebab Chrome AI provider is constructed or active per extension
  origin, even when multiple panel documents exist.
- Chrome AI requests may queue behind unrelated Chrome AI work; the existing AI
  queue already bounds concurrency, and correctness takes priority for the
  on-device provider.
- A still-open older panel remains usable after the newest panel closes.
- Active-port-loss failover can select a standby immediately because its
  provider cannot start until old-document cleanup releases the origin lock.
- Supported Chrome must expose Web Locks in the panel document. Missing
  coordination is a visible non-retryable unavailable-provider failure.
- Tests require one shared, Chrome-ordered Web Locks double plus multi-document
  replacement, disconnect, cancellation, and standby regressions.

## Status

Accepted on 2026-07-19.
