# Glossary

Terms this package uses, especially ones that are not obvious from the code or README. Keep entries short and specific to how `@burnto/pi-neuralwatt` uses them.

## Neuralwatt

The model provider this extension registers. Base URL `https://api.neuralwatt.com/v1`; the catalog comes from `/models`.

## Streaming metadata comments

Neuralwatt sends per-response metadata on the chat-completions SSE stream as comment lines: `: energy {...}` and `: cost {...}`. The OpenAI SDK drops comment lines, so the extension tees the response body and parses them itself.

## Charged cost / `request_cost_usd`

The cost Neuralwatt actually bills for a request, sent in the `: cost` comment. It equals measured energy times the flex multiplier times the account's $/kWh, capped at the request's token price. Preferred over any local estimate.

## Energy accounting / token accounting

The account's billing method, read from `GET /v1/quota` at `balance.accounting_method`. Only `energy` accounts produce energy entries and the status indicator. `token` accounts keep pi's normal cost display.

## `energy_kwh` / `energy_joules`

Measured energy for one response, from the `: energy` comment. An energy entry requires a positive `energy_kwh`.

## Flex multiplier

A discount Neuralwatt applies to energy cost for flex requests (0.65×). It is already folded into `request_cost_usd`; the extension does not apply it separately.

## Fallback rate

`fallbackRateUsdPerKwh` in settings (default `$10/kWh`, overridden by `NEURALWATT_USD_PER_KWH`). Used only when a response has no `: cost` comment, as `energy_kwh × rate`. Marked `costSource: "energy-rate"` and shown with `est.`.

## Cost source

`reported` when the cost came from `request_cost_usd`; `energy-rate` when it came from the fallback rate. Stored on every entry.

## Session entry / custom entry (`neuralwatt-energy-cost`)

One persisted record per measured response, appended with `pi.appendEntry`. It never enters model context. Totals and the status line rebuild from these entries.

## Branch

The active conversation branch, from `sessionManager.getBranch()`. Totals rebuild from the branch rather than the whole session file, so rewind and fork do not double-count abandoned turns.

## `message_end` / `responseId`

`message_end` is the pi hook that fires when a response finishes. `responseId` is the completion id. The extension matches a captured SSE record to the finished message by `responseId`.

## Cache warmer / `cache_warm`

Pi sends warm requests directly through `streamSimple` without a `message_end`. Matching by `responseId` keeps a warm request from consuming a real response's cost. Captured records older than 60 s or beyond 16 pending are dropped.

## `usage.cost` patching (`withChargedCost`)

On `message_end` the extension rewrites the assistant message's `usage.cost`: sub-costs are scaled proportionally and `total` becomes the charged cost. Pi sums `usage.cost.total` for the footer.

## Scoped fetch tee

The SSE tap is installed per request through the stream options' `fetch`, not by patching global `fetch`. Other providers and sessions are unaffected.

## Energy equivalents

Everyday comparisons for accumulated energy: `doomscroll` (phone), `brain`, `led`. Each has an `icon`, a `description`, and a `whPerMinute` rate. The status line shows the icon and a compact duration; `/neuralwatt:cost` spells out the description.

## Status line vs footer

Status line: the `⚡️` energy indicator the extension sets with `ui.setStatus`. Footer: pi's built-in cost display, which sums `usage.cost.total`.

## `registerEntryRenderer`

Pi API for rendering custom session entries in the transcript. Used for the optional per-response line (`perResponseLine`).

## Energy status modes

The `energyStatus` setting: `session` (running total), `last` (most recent response), `both`, or `off`.
