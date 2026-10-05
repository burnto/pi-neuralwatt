# Internals

How the extension works and the invariants to preserve when changing it. User-facing behavior is in the [README](../README.md); unfamiliar terms are in the [glossary](glossary.md).

## Layout

- `index.ts` — extension entry: provider registration, SSE tap, pi hooks, catalog and quota discovery, settings I/O, commands.
- `lib.ts` — pure logic: catalog mapping, reasoning mapping, telemetry schema and totals, formatting, presets, settings parsing, width helpers.
- `test/` — vitest tests, one file per module.

## Provider registration

`registerProvider("neuralwatt", ...)` uses pi's `openai-completions` API against `https://api.neuralwatt.com/v1`. Models come from `/models` and are cached at `~/.pi/agent/cache/neuralwatt-models.json`.

Import the base provider with `getApiProvider` from `@earendil-works/pi-ai/compat`, not the package root. (An earlier port imported it from the root, where the named export does not resolve under pi's loader, so the stream wrapper never installed.)

If the base provider has no `streamSimple`, the provider is still registered but the SSE tap is not installed. `baseProviderAvailable` tracks this and a warning is surfaced once on a Neuralwatt session rather than silently presenting a fully functioning accounting extension.

## Catalog discovery

`/models` returns only the public catalog without a key; enrolled preview models appear only on authenticated requests. The response `scope` field (`public` or `customer`) records which catalog came back, so `authenticated` comes from `scope`, not from whether a key was sent.

Cache-first policy:

- The cache is validated on read (`parseCachedModels`) and schema-versioned. Corrupt entries, or a file whose `version` is missing or unknown, are ignored instead of being cast into model configs.
- If a usable cache exists, it is registered and any refresh runs without blocking startup. A first run or a cache-less state awaits a bounded refresh so headless `--model` resolution can still see the authenticated catalog.
- A refresh that returns only the public catalog never replaces an authenticated catalog.
- The cache stores a SHA-256 fingerprint of the credential used to fetch an authenticated catalog. On load, a fingerprint mismatch discards the private catalog rather than retaining another account's models. An unresolved templated credential counts as a mismatch. Raw keys are never stored.
- Discarding the private catalog also clears the in-memory authenticated flag. Keeping it would make `refreshModels` reject the replacement public catalog and leave the provider registered with zero models.

Pi's offline mode (`PI_OFFLINE` set to `1`, `true`, or `yes`) suppresses every extension-owned discovery request, matching pi's own check. Normal user-requested inference is pi's responsibility.

Pre-session startup key resolution reads `NEURALWATT_API_KEY`, then a plain `api_key` in `auth.json`, and rejects `$`-templated values so an unresolved shell/env expression is never sent as a bearer token. The session-start refresh uses the registry-resolved key.

## Reasoning levels

`metadata.reasoning` in the catalog is mapped onto pi's `thinkingLevelMap`. Pi treats an *undefined* entry as supported for `off`/`minimal`/`low`/`medium`/`high`, but only shows `xhigh`/`max` when a value is defined, so every level the extension cannot confirm is written as explicit `null`. The pre-metadata fallback claims only `off`, `high`, and `max` instead of letting pi default the rest to supported. `off` is disabled (`null`) when the contract says reasoning is mandatory; otherwise it maps to the backend's no-reasoning effort.

Pi has no public per-model default thinking level. `metadata.reasoning.default_enabled` and `default_effort` therefore cannot be honored: pi selects the active level from its own global or per-model thinking setting (defaulting to `medium`) and clamps it with this map. The fields are documented as an accepted limitation rather than reinterpreted.

## SSE tap

The response body is tee'd per request through the stream options' `fetch`. Comment lines are parsed for `energy` and `cost` payloads, and the completion id is read from the `data:` lines. There is no global fetch patching, so concurrent requests from other providers or sessions are unaffected.

## Capture lifetime

Each request joins its metadata capture promise for at most 300 ms, then aborts the tee reader so no branch keeps draining. The join runs before the terminal `done`/`error` event is forwarded to pi, because pi emits `message_end` as soon as it consumes that event and `message_end` must be able to match the completed capture. The completed `{ energy, cost, responseId }` is pushed to a bounded list (16 records, 60 s TTL) and matched in `message_end` by `responseId` only. `message_end` does not wait again. A stream that ends or throws without a terminal event still finalizes, and finalization runs exactly once.

Invariants:

- A capture without a response id never pairs with a message without one; interleaved cache-warmer traffic cannot be consumed by the next real response.
- A successfully generated answer is never turned into a provider failure by capture trouble. Capture errors notify once per session and record missing telemetry.
- `message_end` returns immediately for non-assistant and non-Neuralwatt messages, so unrelated providers never incur the metadata wait or a cost patch.
- Each capture is consumed exactly once; a second `message_end` for an already-recorded response id is ignored, so a completed response is never recorded twice.

## Telemetry and totals

New records use `schemaVersion: 2` / `kind: "response-telemetry"` with independent `energy` and `cost` readings. Legacy `kind: "response-energy"` records migrate in memory (`toResponseTelemetry`) without rewriting session files. `totalsFromEntries` and `lastTelemetryFromEntries` handle both generations.

Energy and cost coverage are tracked independently. Missing values are never summed as zeroes. Request-cost patching prefers a reported cost for any billing method; a fallback estimate is only produced for a confirmed `energy` account, and token/unknown accounts keep pi's token-price estimate.

## Hooks and matching

- `session_start` — rebuild from the branch, detect a credential change, refresh models if the catalog is stale or unauthenticated, refresh quota for Neuralwatt, set status.
- `session_tree` — rebuild from the branch. `/tree` emits this without `session_start`; missing it left abandoned-branch energy in the totals.
- `model_select` / `before_provider_request` — keep quota warm; `model_select` re-renders the status area.
- `message_end` — match capture, build telemetry, append, set status, optionally patch cost.
- `session_shutdown` — clear the status area and pending captures.

## Settings

Settings live in `~/.pi/agent/neuralwatt.json` as `settingsVersion: 3`. Parsing never throws, uses own-property reads, ignores prototype-chain keys, and drops invalid presets and unknown equivalents. The preset catalog is a discriminated union on `kind`: a power preset carries `watts`, a unit preset carries `perKwh` and a literal `unit`. Legacy `energyStatus: "off"` migrates to `energyUiEnabled: false` with `energyStatus: "session"`; the obsolete `doomscroll` equivalent is dropped without substituting another preset. A v2 preset without `kind` is read as power when it has a usable `watts`; the unit kind is never inferred from an absent `kind`, so a preset with only `perKwh`/`unit` is dropped. Parsing always reports `settingsVersion: 3` and does not rewrite the file until a setting is saved.

Unit-equivalent quantities render by magnitude: 1000 and above as an integer, 10 and above with one decimal, the rest with two, and an exact zero as `0`. There are no thousands separators, and non-finite or negative quantities produce no output, matching the power path. The default catalog includes `cookies`, a unit preset at 860.42 / 150 per kWh that treats one cookie as 150 food Calories (kcal); it is an energy equivalence, not a statement about food eaten or a separately measured GPU-only figure.

Writes are best-effort. A failed write keeps the change in memory and surfaces a warning rather than silently succeeding.

## Status area and theme

`ui.setStatus` takes a plain string and Pi has no theme-change event, so the status text is recolored on each session/model/response/toggle event. Between a theme change and the next event, the last rendered color is stale. Replacing the footer or calling `setTheme` as an invalidation hack is intentionally not done.

Per-response transcript annotations respect the renderer width via a grapheme-aware `truncateVisible` in `lib.ts`. Pi's width helpers live in its nested `pi-tui` dependency; implementing a small equivalent avoids a new dependency while still counting wide and emoji graphemes as two cells.

## Historical visibility

Pi 1.0.0 has no public API to rebuild existing transcript entries. Turning the master switch off or on changes the status area and equivalents immediately and governs newly rendered annotations. Existing annotations change on `/reload` or a natural transcript rebuild; the `/neuralwatt:energy-ui` command and shortcut disclose this rather than reloading the session. Tree decoration is out of scope because the label API affects user-owned labels.

## Shortcuts

`registerShortcut` registrations are collected at load; there is no unregister API and extension shortcuts cannot be remapped through `keybindings.json`. `toggleShortcut` is validated with `isValidKeyId` and registered once. Changing or disabling it requires `/reload` or restart. `ctrl+shift+e` needs Kitty keyboard protocol or modifyOtherKeys; legacy terminals may send the same bytes as Ctrl+E, so it does not fire there. Syntax validation does not establish terminal support.

## Gotchas

- npm's `min-release-age` can block `@earendil-works/pi-ai@^1.0.0` on a fresh install. Use `npm install --min-release-age=0`. The lockfile is committed, so CI uses `npm ci`.
- `npm audit` findings in this repo are development-tool advisories (`vitest`, and transitive packages under pi's peer/dev tree). The published package ships only `index.ts`, `lib.ts`, and `README.md`; pi provides the runtime dependencies as peer dependencies, so these are not bundled runtime vulnerabilities.
- Two copies of this extension loaded in one pi process fight over provider registration. Test from source with `-ne` so an installed copy does not win.

## Deferred

- Immediate, gap-free toggling of existing transcript annotations awaits a public Pi refresh mechanism.
- Tree decorations await a public decoration API.
- An allowance meter is not implemented; `/quota` `kwh_used` / `kwh_included` / `kwh_remaining` are account-wide charged-kWh snapshots, distinct from branch-local consumed energy.

## Open work

Maintained list; remove items as they land.

- Publish to npm (`npm publish --access public`) and verify the pi gallery listing.
- Add a gallery preview image if it helps the package page.
