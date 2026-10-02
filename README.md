# @burnto/pi-neuralwatt

Neuralwatt model provider for pi. It puts the cost Neuralwatt actually charges into pi's footer and shows measured session energy in the status line.

## What it does

Neuralwatt sends its charged cost with every response. The extension writes that number into the response's usage record, so pi's footer shows what you were billed rather than the token list price.

A separate `⚡️` indicator accumulates measured `energy_kwh` for the session.

Every measured response is saved as a session entry that never enters model context. The totals survive resume and fork, and they follow the active branch, so rewinding a conversation does not double-count abandoned turns. You can also add an everyday comparison, like how long the session could run a phone, a brain, or an LED bulb.

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
| `session` (default) | `⚡️ 1.42 Wh` |
| `both` | `⚡️ 1.42 Wh (+0.08 Wh)` |
| `last` | `⚡️ 0.08 Wh` |
| `off` | hidden |

Equivalents append to the indicator as an icon and a duration:

```text
⚡️ 1.42 Wh · 🧠 4m16
```

A zero secondary unit is dropped, so two hours reads as `2h` and ninety seconds as `1m30`.

| Icon | Equivalent | Rate | Basis |
| --- | --- | --- | --- |
| 📱 | Doomscrolling | 416 mWh/min | ~25 W for a phone and its network |
| 🧠 | Human brain | 333 mWh/min | ~20 W, the standard cerebral metabolic estimate |
| 💡 | 10 W LED bulb | 167 mWh/min | 10 W |

## Commands

`/neuralwatt:cost` prints session energy, charged cost, request count, the last response, and each configured equivalent with its activity spelled out.

```text
Equivalent:
📱 2m 24s doomscrolling on an iPhone 15
```

`/neuralwatt:settings` opens a menu for the indicator mode, color, equivalents, the per-response transcript line, and the fallback rate. The color choices preview the status text in each theme color.

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
