# Internals

How the extension works and the invariants to preserve when changing it. User-facing behavior is in the [README](../README.md); unfamiliar terms are in the [glossary](glossary.md).

## Layout

- `index.ts` — extension entry: provider registration, SSE tap, pi hooks, settings I/O, commands.
- `lib.ts` — pure logic: catalog mapping, pricing, entry schema, totals, formatting, settings parsing.
- `test/` — vitest unit tests, one file per module.

## Provider registration

`registerProvider("neuralwatt", ...)` uses pi's `openai-completions` API against `https://api.neuralwatt.com/v1`. Models come from `/models` and are cached at `~/.pi/agent/cache/neuralwatt-models.json`.

Import the base provider with `getApiProvider` from `@earendil-works/pi-ai/compat`, not the package root. (An earlier port imported it from the root, where the named export does not resolve under pi's loader, so the stream wrapper never installed.)

`/models` returns only the public catalog without a key; enrolled preview models appear only on authenticated requests. The response `scope` field (`public` or `customer`) records which catalog came back, so `authenticated` comes from `scope`, not from whether a key was sent. An authenticated cached catalog is never replaced by the smaller public one.

## SSE tap

The response body is tee'd per request through the stream options' `fetch`. Comment lines are parsed for `energy` and `cost` payloads, and the completion id is read from the `data:` lines. There is no global fetch patching, so concurrent requests from other providers or sessions are unaffected.

## Cost resolution

1. `request_cost_usd` from the `: cost` comment, used when it is a finite non-negative number.
2. `energy_kwh × rate` for energy accounts when the comment is missing.

See the [glossary](glossary.md) for these terms.

## Hooks and matching

`message_end` matches the captured record to the finished message by `responseId`. Totals rebuild from the active branch on `session_start` and in the `/neuralwatt:cost` command.

## Invariants

- Cost replacement happens in place before pi persists the message. Pi sums `usage.cost.total` for the footer, so the patched total is what the user sees.
- Totals follow the active branch, never the whole session file.
- Captured records are matched by `responseId`. Cache-warm requests must not be counted against a real response.
- An energy entry requires a positive `energy_kwh`; token accounts never produce entries.
- Settings writes are best-effort. The in-memory `settings` object is shared by the menu, renderer, and status closures, so it updates immediately even if the file write fails.

## Gotchas

- npm's `min-release-age` can block `@earendil-works/pi-ai@^1.0.0` on a fresh install. Use `npm install --min-release-age=0`. The lockfile is committed, so CI uses `npm ci`.
- Two copies of this extension loaded in one pi process fight over provider registration. Test from source with `-ne` so an installed copy does not win.

## Open work

Maintained list; remove items as they land.

- Publish to npm (`npm publish --access public`) and verify the pi gallery listing.
- Decide whether `perResponseLine` should default on.
- Add a gallery preview image if it helps the package page.
