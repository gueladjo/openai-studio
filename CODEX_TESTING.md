# Testing OpenAI Studio

Use [AGENTS.md](AGENTS.md#definition-of-done) to select validation by change scope.
The [contract table](docs/IMPLEMENTATION.md#acceptance-criteria-and-traceability)
links behaviors to focused tests. This guide owns execution and platform limits.

## Setup and local isolation

Use Node.js 22.12+ and `npm ci`. If WSL resolves a missing or Windows runtime,
check the interactive login shell as described in [README](README.md#quick-start):

```bash
bash -ilc 'command -v node && command -v npm && node --version && npm --version'
```

Vitest uses mocked SDK calls, in-memory OPFS/IndexedDB, and disposable filesystem
fixtures. Its controller coverage uses `happy-dom` with mocked child components
and services. Local tests need no live key, real browser profile, real workspace,
or Electron process. Run and retry these checks as part of authorized work;
keep fixtures isolated when extending the suite.

There is no lint or format script. Finite checks include:

```bash
npm test -- services/workspaceSchema.test.ts
npm test -- services/storage.integration.test.ts
npm test -- services/openaiService.generate.test.ts
npx --no-install tsc --noEmit
```

`npm test` runs the full suite once (`vitest run`). `npm run build` and
`npm run build:electron` run TypeScript and create Electron-mode renderer output;
`npm run build:web` runs TypeScript and creates web/PWA output. Both use `dist/`,
so build the desired mode before previewing or packaging it. A successful build
already includes the TypeScript check; do not repeat it without a reason.

## Select validation

Use the affected tests in the contract table. Expand to integration coverage when
state, ownership, storage, or API boundaries interact. Run the full suite for
broad changes, releases, or failures suggesting shared regressions. Build the
affected delivery mode when bundling or platform compatibility is in question;
shared delivery changes need both modes.

For runtime checks, exercise the changed behavior and plausible regressions:

| Area | Additional evidence |
| --- | --- |
| Responsive UI | Web at desktop and below/around 768px; affected overflow, dialogs, keyboard/focus, and themes |
| PWA/configuration | `npm run build:web`, then `npm run preview`; verify `/openai-studio/`, manifest, registration, and cached shell |
| Electron/preload | `npm run electron:dev` on a supported desktop; exercise affected IPC, navigation, clipboard, file-picker, backup publication, or close/recovery behavior |
| Packaging | `npm run dist` on the requested target host with its packaging/signing tooling |

`npm run dev`, `npm run preview`, and `npm run electron:dev` are long-running
processes; stop owned processes after testing. Electron development reserves
port 5173. Mocked tests and renderer builds do not prove native Electron or real
file-picker behavior. Browser mobile emulation does not prove installed-PWA or
physical-device behavior. Report the actual platform and unexercised paths.

Live API smoke tests need authorization to use the account: they consume quota
and create stored responses/resources. Local tests do not supply that permission.

## Commands with additional effects

These effects must fit the requested scope. Existing authorization is sufficient;
finish local preparation before asking for any still-needed external action.

| Command | Effect |
| --- | --- |
| `npm run clean` | Removes dependencies, build/package output, and logs; inspect with `npm run clean -- --dry-run` first |
| `node scripts/generate-icons.js` | Overwrites tracked PNG icons |
| `npm version patch\|minor\|major` | Changes version files and creates a commit/tag by default |
| `npm run dist` | Builds and packages Electron artifacts in `release/` |
| `npm run deploy` | Builds web output and publishes `dist/` through `gh-pages` |

Development and Electron Vite modes may inline `OPENAI_API_KEY`. Check that
artifacts contain no developer key before any authorized distribution.
