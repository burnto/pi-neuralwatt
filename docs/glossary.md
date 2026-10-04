# Glossary

Terms this package uses, especially ones that are not obvious from the code or README. Keep entries short and specific to how `@burnto/pi-neuralwatt` uses them.

## Neuralwatt

The model provider this extension registers. Base URL `https://api.neuralwatt.com/v1`; the catalog comes from `/models`.

## Streaming metadata comments

Neuralwatt sends per-response metadata on the chat-completions SSE stream as comment lines: `: energy {...}` and `: cost {...}`. The OpenAI SDK drops comment lines, so the extension tees the response body and parses them itself.

## Reported energy

`energy_kwh` from the `: energy` comment, recorded as an energy reading with status `reported`. It is provider-reported, not a locally measured value, and the extension does not claim to measure anything itself. A reported `0` is a real zero, distinct from missing metadata.

This is the energy Neuralwatt attributes to the accelerator work for the request. It excludes broader system and datacenter overhead such as host power, cooling, networking, and facility losses; it is not a full-boundary energy figure.

## Thinking level map

Pi's `thinkingLevelMap` on a model: maps pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to provider `reasoning_effort` strings, with `null` disabling a level. Pi treats an *undefined* entry as supported for `off`/`minimal`/`low`/`medium`/`high`, but requires a defined value for `xhigh`/`max`. The extension therefore lists every level explicitly; the pre-metadata fallback claims only `off`, `high`, and `max`. `metadata.reasoning.mandatory` disables `off`. `default_enabled`/`default_effort` are not honored because pi exposes no public per-model default: pi chooses the active level from its own thinking setting (default `medium`) and clamps it with this map.

## Offline mode

`PI_OFFLINE` set to `1`, `true`, or `yes` (case-insensitive), matching pi. It suppresses extension-owned discovery requests (`/models`, `/quota`); normal user-requested inference is pi's responsibility.

## Attribution method / measurement availability

Optional fields on the energy comment. `attribution_method` is preserved as provenance. `measurement_available: false` means the reading is `unavailable`; it is never presented as a verified measurement or turned into a cost estimate.

## Reported request cost

`request_cost_usd` from the `: cost` comment, recorded as a cost reading with status `reported`. A reported `0` is meaningful and never triggers a fallback estimate. It is what Neuralwatt reports, not proof of an incremental dollar debit on a subscription.

## Energy-rate estimate

A locally calculated `energy_kwh × rate`, recorded with status `estimated` and the exact rate used at the time. Only produced for a confirmed `energy` account with usable reported energy. Historical estimates keep their original rate.

## Configured energy-rate equivalent

An illustrative dollar value in `/neuralwatt:cost`, calculated from the session's available reported energy and the current configured rate. It excludes allowances, is not a provider-reported charge, and may differ from actual pay-as-you-go pricing because of flex discounts and caps. It never replaces a valid reported cost.

## Fallback rate

`fallbackRateUsdPerKwh` in settings (default `$10/kWh`, overridden by `NEURALWATT_USD_PER_KWH`). Used for the energy-rate estimate and the energy-rate equivalent. The effective value and its source are shown in settings and the cost report.

## Flex multiplier

A discount Neuralwatt applies to energy cost for flex requests. It is already folded into `request_cost_usd`; the extension does not apply it separately, and keeps effective alias pricing as published.

## Coverage

Independent per-session counts: how many recorded responses had reported energy, and how many had a usable reported or estimated cost. Reported energy and reported cost are tracked separately, because a response can have one without the other.

## Recorded responses

The number of foreground Neuralwatt responses this extension recorded telemetry for. It is not a claim to count every provider request: retries, cache-warm calls, background compaction, and activity outside this extension may not be represented.

## Response telemetry record (`neuralwatt-energy-cost`)

One persisted record per response, appended with `pi.appendEntry`; it never enters model context. New records use `schemaVersion: 2` and `kind: "response-telemetry"` with independent `energy` and `cost` readings plus optional account context. Totals and the status area rebuild from these entries.

## Legacy entry

A record with `kind: "response-energy"` and no schema version, written by earlier versions. Read without rewriting session files or double-counting; its missing provenance and response id are treated as unknown.

## Missing / unavailable / invalid

How a reading without a usable value is labeled. `missing` means no metadata was supplied, `unavailable` means the provider said so, `invalid` means a value was present but unusable (negative, NaN, infinite). Missing values are never counted as zero.

## Accounting method

The account's billing method, read from `GET /v1/quota` at `balance.accounting_method`: `energy` or `token`. Used only to gate the energy-rate estimate. An unknown method is not evidence of token billing.

## Quota snapshot

A cached `/quota` result holding the accounting method and `subscription`. Successful snapshots live five minutes; failures back off 30 seconds; one request is shared. Absence of a snapshot means the account context is unknown, not that there is no subscription. `subscription: null` means the snapshot reported no subscription.

## Branch

The active conversation branch, from `sessionManager.getBranch()`. Totals rebuild from the branch rather than the whole session file, so rewind and fork do not double-count abandoned turns. Rebuilt on `session_start`, `session_tree`, and the cost command.

## `message_end` / `responseId`

`message_end` is the pi hook that fires when a response finishes. `responseId` is the completion id. The extension matches a captured SSE record to the finished message by `responseId` only; a capture or message without one is never paired.

## Cache warmer / `cache_warm`

Pi sends warm requests directly through `streamSimple` without a `message_end`. Matching by `responseId` keeps a warm request from consuming a real response's cost. Captured records older than 60 s or beyond 16 pending are dropped.

## Scoped fetch tee

The SSE tap is installed per request through the stream options' `fetch`, not by patching global `fetch`. Other providers and sessions are unaffected. Metadata capture is joined for at most 300 ms before the terminal event is forwarded; on expiry the reader is aborted.

## `usage.cost` patching (`withChargedCost`)

On `message_end` the extension rewrites the assistant message's `usage.cost`: sub-costs are scaled proportionally and `total` becomes the reported or estimated cost. Pi sums `usage.cost.total` for the footer. Those sub-costs are allocations, not provider-reported billing breakdowns.

## Master visibility (`energyUiEnabled`)

Persisted switch, default on. It controls the extension-owned automatic energy UI: the primary status indicator, enabled equivalents, and newly rendered per-response annotations. It does not control provider registration, telemetry capture, persistence, billing lookup, or `patchPiCost`. Pi's normal dollar-cost display stays available when the energy UI is hidden. `/neuralwatt:toggle` and the optional shortcut flip it.

## Status area vs footer

Status area: the `⚡️` energy indicator the extension sets with `ui.setStatus`. Footer: pi's built-in cost display, which sums `usage.cost.total` and shows a bare number without an extension-specific source label.

## `registerEntryRenderer`

Pi API for rendering custom session entries in the transcript. Used for the optional per-response line (`perResponseLine`), which respects the available width.

## Comparison preset

An editable `{ id, icon, label, watts }` definition. `watts` is a constant power draw, entered in watts. The duration is `energyKwh × 3_600_000 / watts`. Preset ids are stable identity; labels, icons, and watts are editable. Defaults: `brain` (20 W), `led` (10 W), `kettle` (1,500 W rated).

## Energy status modes

The `energyStatus` setting: `session` (running total), `last` (most recent response), or `both`. Visibility is now governed by `energyUiEnabled`; the legacy `off` value migrates to `energyUiEnabled: false`.

## `toggleShortcut`

A `KeyId` string or `null`. Registered at extension load only; there is no unregister API, so changing or disabling it takes effect after `/reload` or restart. `ctrl+shift+e` needs Kitty keyboard protocol or modifyOtherKeys; legacy terminals may deliver the same bytes as Ctrl+E, so the binding does not fire there. `alt+e` is an alternative.
