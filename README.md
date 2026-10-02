# @burnto/pi-neuralwatt

Neuralwatt model provider for pi. It puts the cost Neuralwatt actually charges into pi's footer, and shows measured session energy in the status line.

## What it does well

- **Charged cost, not a token-price guess.** Every Neuralwatt response carries its charged cost in an SSE comment: measured energy times the flex multiplier times your rate, capped at the token price. The extension writes that number into the response's usage record, so pi's footer total matches your bill. Pi's default cost is computed from token list prices and can differ by several times.
- **Energy in the status line.** `⚡︎` is reserved for energy. The indicator accumulates the measured `energy_kwh` from each response, so you can see how much energy a session uses.
- **Recorded in session history.** Each measured response is saved as a session entry that never enters model context. The totals survive resume and fork, and they follow the active branch, so rewinding a conversation does not double-count abandoned turns.
- **Configurable, with everyday units.** Pick what the indicator shows, give it a theme color, and optionally add comparisons like minutes of doomscrolling or running a human brain.

## Install

```sh
# from npm
pi install npm:@burnto/pi-neuralwatt

# from git
pi install git:github.com/burnto/pi-neuralwatt
```

Requires pi 1.0.0 or later.

## Setup

The provider uses pi's normal credential handling.

- Add a key under `neuralwatt` in `~/.pi/agent/auth.json`, or
- set `NEURALWATT_API_KEY`.

The model catalog comes from `https://api.neuralwatt.com/v1/models` and is cached at `~/.pi/agent/cache/neuralwatt-models.json`. An authenticated catalog includes enrolled preview models and never gets replaced by the smaller public catalog.

## Status line

The status line shows session energy while a Neuralwatt model is active on an energy-accounting account. Token-accounting accounts keep pi's normal cost display.

| Mode | Example |
| --- | --- |
| `session` (default) | `⚡︎1.42 Wh` |
| `both` | `⚡︎1.42 Wh (+0.08 Wh)` |
| `last` | `⚡︎0.08 Wh` |
| `off` | hidden |

With equivalents enabled, the indicator appends them:

```text
⚡︎1.42 Wh · 3.4 min doomscrolling
```

| Equivalent | Rate | Basis |
| --- | --- | --- |
| Doomscrolling | 416 mWh/min | ~25 W for a phone and its network |
| Human brain | 333 mWh/min | ~20 W, the commonly cited figure |
| 10 W LED bulb | 167 mWh/min | 10 W |

## Commands

- `/neuralwatt:cost` shows session energy, charged cost, request count, the last response, and any configured equivalents.
- `/neuralwatt:settings` opens a menu for the indicator mode, color, equivalents, the per-response transcript line, and the fallback rate.

## Cost sources

1. `request_cost_usd` from the response stream. This is the charged cost and wins when present.
2. `energy_kwh × rate` when the response has no cost comment. The default rate is `$10/kWh`, Neuralwatt's current pay-as-you-go list price. Entries that use the fallback are marked as estimates.

Subscription accounts pay a lower overage rate. Set it in `/neuralwatt:settings`, in `~/.pi/agent/neuralwatt.json`, or with `NEURALWATT_USD_PER_KWH`, which takes precedence.

## Settings

Settings live in `~/.pi/agent/neuralwatt.json`.

```json
{
  "energyStatus": "session",
  "energyColor": "dim",
  "equivalents": [],
  "patchPiCost": true,
  "perResponseLine": false,
  "fallbackRateUsdPerKwh": 10
}
```

- `energyStatus`: `session`, `last`, `both`, or `off`.
- `energyColor`: `dim`, `muted`, `text`, `accent`, `success`, `warning`, or `error`.
- `equivalents`: any of `doomscroll`, `brain`, `led`.
- `patchPiCost`: replace pi's token-price cost with the charged cost.
- `perResponseLine`: show a one-line entry in the transcript for each measured response.
- `fallbackRateUsdPerKwh`: rate used only when a response has no cost comment.

## Development

```sh
npm install
npm run check

# load the extension from source without other installed extensions
pi -ne -e . -p "hi" --model neuralwatt/deepseek-v4-flash
```

## License

MIT
