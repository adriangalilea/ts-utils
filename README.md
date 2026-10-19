# ts-utils

TypeScript utilities, one package per audience: the core every program uses, and the Telegram bot plugins, the LLM caller and product metrics as packages of their own, so a program installs only what it needs.

| Package | What it is |
|---|---|
| [`@adriangalilea/utils`](packages/utils/README.md) | The core: logger, offensive programming, format, time, url, currency, ansi, CLI presentation, live output and command-line programs, say, xdg, kev, unseen, file and project helpers |
| [`@adriangalilea/llm`](packages/llm/README.md) | Multi-provider LLM caller on the Vercel AI SDK: failover, circuit breaker, cost accounting, tool loop, structured output |
| [`@adriangalilea/bot`](packages/bot/README.md) | GramIO plugins for personal Telegram bots, and the Telegram HTML and Markdown renderers (`tg-html`, `tg-md`) |
| [`@adriangalilea/metrics`](packages/metrics/README.md) | Product metrics: declared counters and timings over one SQLite dialect (libSQL, D1, D1 REST), with reports |

The sibling of [swift-utils](https://github.com/adriangalilea/swift-utils), [py-utils](https://github.com/adriangalilea/py-utils), and [go-utils](https://github.com/adriangalilea/go-utils). The logging contract the three share, and the harness that proves they write the same event stream, live in [utils](https://github.com/adriangalilea/utils).

## Development

A pnpm workspace. Packages reach each other with `workspace:^` and read each other's `src` through the `adriangalilea-source` export condition (tsc through `customConditions` in each package's `tsconfig.json`, tests through `node --conditions`), so no build stands between an edit and a test.

- `pnpm verify` is the whole gate: biome, types, every package's tests and the repo-wide checks.
- Tests sit beside the code as `*.test.ts` and run under `node --test`: `pnpm test` runs them all, `pnpm --filter <pkg> test` one package, `pnpm --filter <pkg> test:watch` on every save.
- `pnpm test:repo` runs the repo-wide checks: the bot surface stays Worker-safe, and library code writes no raw `console.*`.
- Live checks that call real services are `*.live.ts` and never run in the gate (`pnpm --filter @adriangalilea/llm test:live`).
- `pnpm consumers <root>...` (or `CONSUMERS_ROOTS`) compiles every program that depends on these packages against the local `src` and lists what would break. Run it before any breaking release.

## Release

Each package has its own version and npm name. Bumping a package's version in its `package.json` and pushing to `main` publishes that package through CI, with [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) (no tokens: GitHub Actions proves identity directly to npm). Tags are `vX.Y.Z` for `@adriangalilea/utils` and `llm-vX.Y.Z`, `bot-vX.Y.Z`, `metrics-vX.Y.Z` for the others. Release notes come from conventional commits through [git-cliff](https://github.com/orhun/git-cliff); a breaking change is explained in the commit's `BREAKING CHANGE` footer.

## License

MIT
