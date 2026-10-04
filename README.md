# @burnto/pi-neuralwatt

Neuralwatt model provider for pi. It reports the request cost Neuralwatt sends and, optionally, the provider-reported energy a session consumes.

## What it does

Neuralwatt sends per-response telemetry on its response stream: a reported request cost, and reported GPU energy where it is available. The extension records both as session entries that never enter model context, and can write the reported cost into the response's usage record so pi's footer shows what Neuralwatt reported rather than the token list price.

A separate `⚡️` indicator shows reported energy in pi's status area while a Neuralwatt model is active. You can add everyday comparisons, like how long the session's energy could run a human brain, a 10 W LED bulb, or a 1,500 W kettle.

Totals follow the active branch, so rewinding or forking a conversation does not double-count abandoned turns.

Reported energy is provider-reported, not measured by this extension, and a reported dollar value is not proof of an incremental charge. Coverage is explicit: if energy or cost metadata is missing for a response, it is recorded as missing rather than counted as zero.

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

- Add a key under `neuralwatt` in `~/.pi/agent/auth.json`:

  ```json
  {
    "neuralwatt": { "type": "api_key", "key": "sk-..." }
  }
  ```

- or set `NEURALWATT_API_KEY`.

The model catalog comes from `https://api.neuralwatt.com/v1/models` and is cached at `~/.pi/agent/cache/neuralwatt-models.json`. An authenticated catalog includes enrolled preview models and never gets replaced by the smaller public catalog. Startup reads `NEURALWATT_API_KEY` or a plain `api_key` entry; a `$`-templated key is not sent as a bearer token before a session exists.

## Status area

With the energy UI on and a Neuralwatt model active, the status area shows reported energy according to the indicator mode. Before any reported energy, it reads `⚡️ no data`; a reported zero reads `⚡️ 0 Wh`.

| Mode | Example |
| --- | --- |
| `session` (default) | `⚡️ 1.42 Wh` |
| `both` | `⚡️ 1.42 Wh (+0.08 Wh)` |
| `last` | `⚡️ 0.08 Wh` |

Equivalents append to the indicator as an icon and a duration:

```text
⚡️ 1.42 Wh · 🧠 4m16
```

The energy UI is presentation only. Hiding it does not stop telemetry collection, persistence, or cost patching, and pi's normal dollar-cost display stays available. Turn it off and on with `/neuralwatt:toggle`, `/neuralwatt:toggle off`, `/neuralwatt:toggle on`, or the optional shortcut.

## Commands

`/neuralwatt:cost` prints recorded responses, reported energy with its coverage, reported cost plus estimates with its coverage, the effective rate, the last response, account context, and any enabled equivalents. It works even when the energy UI is hidden, and does not turn it on.

`/neuralwatt:toggle [on|off]` shows or hides the energy UI and saves the choice.

`/neuralwatt:settings` opens a menu for the master switch, the indicator mode and color, enabled equivalents, the editable comparison presets, pi footer cost patching, the per-response transcript line, the fallback rate, and the shortcut.

## Cost sources

1. `request_cost_usd` from the response stream. This is the reported cost and wins when present. A reported `0` is kept and never triggers an estimate.
2. `energy_kwh × rate` when the response has no reported cost, but only when the account's billing method is confirmed as energy. Token and unknown accounts keep pi's normal token-price estimate instead.

The default rate is `$10/kWh`. Estimates are recorded with the rate used at the time, so changing the setting does not rewrite history. The settings menu and cost report show the effective rate and whether it comes from the saved setting or `NEURALWATT_USD_PER_KWH` (which takes precedence).

The same rate is used for the **energy-rate equivalent** line in `/neuralwatt:cost` when subscription or token-account energy is present. That line is an illustrative reference: it excludes account allowances and may differ from actual pay-as-you-go pricing because of flex discounts and caps.

## Comparison presets

Each preset compares energy to the duration of a constant power draw:

```text
durationSeconds = energyKwh × 3_600_000 / watts
```

Power is in **watts**; energy is **Wh or kWh**. Results are approximate equivalents, not claims about identical work, lifecycle energy, or emissions.

| ID | Icon | Label | Watts | Basis |
| --- | --- | --- | --- | --- |
| `brain` | 🧠 | Human brain | 20 | Approximate whole-brain metabolic power, not electrical consumption |
| `led` | 💡 | 10 W LED bulb | 10 | Defined 10 W electrical load |
| `kettle` | 🫖 | 1,500 W electric kettle | 1500 | Manufacturer-rated input while heating, not a measured boil cycle |

At 1 Wh the equivalents are about 3 minutes, 6 minutes, and 2.4 seconds. Presets are editable: add, edit icon/label/watts, remove with confirmation, and restore defaults with confirmation, all from `/neuralwatt:settings`. Removing a preset deletes its definition; disabling removes only its enabled id. An empty catalog survives restart; defaults are restored only by an explicit action.

## Settings

Settings live in `~/.pi/agent/neuralwatt.json`.

```json
{
  "settingsVersion": 2,
  "energyUiEnabled": true,
  "energyStatus": "session",
  "energyColor": "dim",
  "equivalents": [],
  "equivalentPresets": [
    { "id": "brain", "icon": "🧠", "label": "Human brain", "watts": 20 },
    { "id": "led", "icon": "💡", "label": "10 W LED bulb", "watts": 10 },
    { "id": "kettle", "icon": "🫖", "label": "1,500 W electric kettle", "watts": 1500 }
  ],
  "patchPiCost": true,
  "perResponseLine": false,
  "fallbackRateUsdPerKwh": 10,
  "toggleShortcut": "ctrl+shift+e"
}
```

- `energyUiEnabled`: master switch for extension-owned energy UI.
- `energyStatus`: `session`, `last`, or `both`.
- `energyColor`: `dim`, `muted`, `text`, `accent`, `success`, `warning`, or `error`.
- `equivalents`: ordered list of enabled preset ids.
- `equivalentPresets`: editable preset definitions. An absent field uses defaults; `[]` is intentionally empty.
- `patchPiCost`: write the reported or estimated cost into pi's footer cost.
- `perResponseLine`: show a one-line entry per recorded response.
- `fallbackRateUsdPerKwh`: rate for the energy-rate estimate and equivalent.
- `toggleShortcut`: a key binding, or `null` to disable.

Older settings files migrate on load: `energyStatus: "off"` becomes `energyUiEnabled: false` with `energyStatus: "session"`, and the removed `doomscroll` equivalent is dropped.

## Shortcut

Extension shortcuts are registered at loading, and pi has no unregister API, so changing or disabling `toggleShortcut` takes effect after `/reload` or restart. `ctrl+shift+e` only fires when the terminal supports the Kitty keyboard protocol or modifyOtherKeys; legacy terminals may deliver the same bytes as Ctrl+E, so the binding will not work there. Use `alt+e` as an alternative, configured in `neuralwatt.json` (on macOS, enable Option as Meta in your terminal). The `/neuralwatt:toggle` command always works.

## Limitations

- "Recorded responses" counts foreground Neuralwatt responses this extension saw. Retries, cache-warm calls, background compaction, and activity outside this extension may not be represented.
- Existing transcript annotations refresh on `/reload` or a natural transcript rebuild; toggling the energy UI changes the status area and equivalents immediately but not already-rendered annotations.
- Tree decorations are not supported on pi 1.0.0 (no public decoration API).
- pi's footer shows a bare numeric total without an extension-specific source label, so a mixed reported-plus-estimated total is not annotated there; `/neuralwatt:cost` explains the breakdown.

## Development

```sh
npm install
npm run check

# load the extension from source without other installed extensions
pi -ne -e . -p "hi" --model neuralwatt/deepseek-v4-flash
```

## License

MIT
