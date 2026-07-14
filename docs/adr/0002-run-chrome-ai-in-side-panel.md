# ADR 0002: Run Chrome Built-in AI in the side-panel document

## Context

Chrome's [Prompt API documentation](https://developer.chrome.com/docs/ai/prompt-api) states that the API is unavailable in Web Workers. TabKebab currently invokes every provider from its Manifest V3 service worker, so the Chrome Built-in AI provider cannot connect or complete there.

Smart grouping and natural-language commands originate in the side panel. Focus Mode classification may run later from background navigation events, including while no side panel exists.

## Decision

Execute `LanguageModel` operations in the side-panel document. The panel opens a named runtime port to the service worker and acts as the foreground Chrome-AI broker. The service worker sends request IDs and serializable prompt payloads over that port and receives structured success or error results.

When no broker port is connected, Chrome Built-in AI fails with a specific foreground-required error. Background Focus Mode classification skips the uncached Chrome-AI request rather than opening UI, falling back to deterministic strict/category rules.

## Alternatives rejected

- **Keep execution in the service worker:** incompatible with the Prompt API platform contract.
- **Use an offscreen document:** the Prompt API is documented for top-level documents and same-origin frames, and the Offscreen API has no AI execution reason. Depending on this undocumented combination would be fragile.
- **Remove Chrome Built-in AI:** discards a privacy-preserving provider that works for foreground features.
- **Require the side panel to remain open silently:** background behavior would remain unreliable and errors would be unclear.

## Consequences

- Chrome Built-in AI is explicitly foreground-only.
- Smart grouping, commands, model checks, and other panel-initiated operations work in the supported document context.
- Focus Mode remains correct when the panel closes; it does not perform stale or unsupported AI actions.
- Port lifecycle, request correlation, disconnect rejection, and timeout cancellation require automated tests.

## Status

Accepted on 2026-07-14.
