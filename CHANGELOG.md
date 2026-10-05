# Changelog

## Unreleased

- Rename the visibility command from `/neuralwatt:toggle` to `/neuralwatt:energy-ui`. `on`, `off`, and the bare toggle behave as before, and no alias is registered.
- Render a missing energy reading as `0 Wh` in the status indicator instead of `no data`. The reading stays missing for totals and coverage, and enabled equivalents render at zero too.

## 0.2.0

- Fix session-tree navigation so rewinding a conversation immediately drops the abandoned branch's energy instead of adding it to the next response.
- Return from `message_end` for other providers, so unrelated responses no longer wait on Neuralwatt metadata or receive a cost patch.
- Replace the shared capture queue with per-response metadata joined for at most 300 ms and matched by response id only.
- Version the persisted record (`schemaVersion: 2`, `kind: "response-telemetry"`) with independent reported energy and reported cost readings, coverage counts, and provenance. Legacy records are read without rewriting session files.
- Collect reported energy for token and unknown accounts too; keep the energy-rate estimate to confirmed energy accounts.
- Track reported energy and reported cost coverage separately and label partial totals.
- Read the `/models` catalog cache-first, validate cached entries, protect the authenticated scope, and drop another account's private catalog on a credential change.
- Validate and cache `/quota` account context: one shared in-flight request, five-minute success cache, 30-second failure backoff, offline-aware.
- Report the effective fallback rate and its source, and validate rate input with feedback.
- Add editable comparison presets (`brain`, `led`, `kettle`) with add/edit/remove/restore, and migrate settings to `settingsVersion: 2`. Remove the unsupported `doomscroll` equivalent.
- Add `energyUiEnabled` as the master visibility switch, plus `/neuralwatt:toggle [on|off]` and a configurable `toggleShortcut`.
- Respect terminal width in per-response annotations; use reported-cost terminology throughout; update the docs.
- Add `prepublishOnly: npm run check`.

Settings from 0.1.x migrate on load: `energyStatus: "off"` becomes `energyUiEnabled: false`, and `doomscroll` is removed.
