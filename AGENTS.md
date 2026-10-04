# AGENTS.md

Guidance for coding agents working in this repo.

`@burnto/pi-neuralwatt` is a pi extension that registers the Neuralwatt provider, taps the provider's SSE energy and cost metadata, and writes the reported request cost into pi's footer.

## Documentation

- [docs/glossary.md](docs/glossary.md) — domain terms, units, SSE fields, and pi concepts used here. **Keep it current.** When you add or rename a term, unit, setting, field, or concept, update the glossary in the same change.
- [docs/internals.md](docs/internals.md) — architecture, invariants, gotchas, and open work. Update it when behavior or an invariant changes.
- [README.md](README.md) — user-facing docs. Leave it aimed at people installing and using the package.

## Layout

- `index.ts` — extension entry: provider registration, SSE tap, pi hooks, settings I/O, commands.
- `lib.ts` — pure logic. Keep it free of pi APIs and I/O.
- `test/` — vitest tests, one file per module.
- `docs/` — glossary and internals.

## Commands

```sh
npm run check        # typecheck + tests; run before committing
npm run test:watch

# run from source, isolated from an installed copy of this extension
pi -ne -e . -p "hi" --model neuralwatt/deepseek-v4-flash
```

`-ne` disables other extensions. Without it, an installed copy can win provider registration and the source changes will not take effect.

## Conventions

- Tabs, double quotes, semicolons. Follow the existing formatting.
- Keep pure logic in `lib.ts` and add a unit test for it.
- Do not commit `HANDOFF.md`; it is a transient scratch file.
