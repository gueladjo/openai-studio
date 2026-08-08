# Repository Guidelines

This file is the canonical working contract for coding agents in this
repository. Read [README.md](README.md) for the project overview, setup, basic
usage, deployment, and user-facing safety guidance. Read the relevant section
of [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) before changing code; it is
canonical for intended behavior, architecture, interfaces, invariants, failure
handling, and acceptance criteria.

Update `docs/IMPLEMENTATION.md` whenever a change alters intended behavior,
architecture, a public or persisted interface, an invariant, or failure and
recovery semantics. Update `README.md` when setup, operation, deployment,
privacy, backup warnings, or another user-visible workflow changes. Keep
tool-specific files such as `CLAUDE.md` limited to compatibility notes and links
to these canonical documents.

## Project Overview

OpenAI Studio is a React 19 and TypeScript client for the OpenAI Responses API.
Vite produces web/PWA or Electron renderer bundles, and the SDK runs directly in
the renderer. Start work at the narrowest boundary in the map below; use the
implementation specification for the behavior those boundaries must preserve.

## Task And Ownership Map

`App.tsx` is the state and workflow orchestrator: it composes the extracted
coordination helpers, storage facade, and API service. Keep locally testable
rules in their existing modules rather than expanding the controller.
`services/storage.ts` is the public persistence facade and composes schema,
backend, and immutable-generation modules. `services/openaiService.ts` is the
Responses API boundary for request construction, streaming, cancellation,
citations, and generated files.

Use this map to start a change at the narrowest boundary:

| Agent task | Canonical source | Focused contract |
| --- | --- | --- |
| Persisted session/settings/instruction fields, bounds, IDs, and references | `services/workspaceSchema.ts` | `services/workspaceSchema.test.ts`; add `services/storage.integration.test.ts` when the public storage flow changes |
| OPFS/IndexedDB selection and Electron fallback policy | `services/storageBackend.ts` | `services/storageBackend.test.ts` |
| Immutable objects, alternating manifests, complete-generation validation, pinning, and GC | `services/workspaceGenerationStore.ts`; manifest types in `services/workspaceGeneration.ts` | `services/storage.integration.test.ts` |
| Portable ZIP layout, hashes, path/size limits, and merge/restore inspection | `services/workspaceArchive.ts` | `services/workspaceArchive.test.ts` |
| Whole-chat backup merge, collision remapping, instruction reuse, ordering, and imported-blob selection | `services/workspaceMerge.ts` | `services/workspaceMerge.test.ts`; `services/storage.integration.test.ts` |
| Mandatory recovery-point creation and merge/restore undo | `services/workspaceRestore.ts` | `services/storage.integration.test.ts` |
| Daily scheduling, read-back validation, retries, and three-file retention | `services/backupScheduler.ts` | `services/backupScheduler.test.ts` |
| Web/Electron destination capability and managed-file policy | `services/backupDestination.ts`; `electron/backupFiles.js` | `electron/backupFiles.test.js`; `electron/main.test.js` |
| Cross-tab writer/reader ownership and reload coordination | `services/workspaceSync.ts` | `services/workspaceSync.test.ts` |
| Debounced, versioned, retried, and flushed saves | `services/saveQueue.ts` | `services/saveQueue.test.ts` |
| In-flight operation ownership and session/workspace invalidation | `services/operationRegistry.ts` | `services/operationRegistry.test.ts` |
| Partial response accumulation and atomic stop/lifecycle checkpoints | `services/responseStreamState.ts` | `services/responseStreamState.test.ts`; `App.integration.test.tsx` |
| Serialization of destructive or workspace-wide operations | `services/serializedOperationQueue.ts` | `services/serializedOperationQueue.test.ts` |
| Supported attachment formats, MIME normalization, and size limits | `utils/attachmentValidation.ts` | `utils/attachmentValidation.test.ts` |
| Per-session composer draft transitions | `utils/chatDrafts.ts` | `utils/chatDrafts.test.ts` |
| Destructive chat confirmation policy | `utils/chatDeletion.ts` | `utils/chatDeletion.test.ts` |
| Electron external-navigation and same-document policy | `electron/urlPolicy.js` | `electron/urlPolicy.test.js` |
| Electron development-server identity and readiness checks | `electron/devServer.js` | `electron/devServer.test.js` |

Other primary entry points:

- `index.tsx`: React bootstrap.
- `App.integration.test.tsx`: happy-dom controller coverage with mocked child components, storage, workspace coordination, and OpenAI calls; protects startup writes, request routing/termination, destructive races, and close flushing.
- `components/ChatArea.tsx`: composer, attachments, message rendering, response details, citations, generated files, and conversation Markdown export.
- `components/Sidebar.tsx`: chat search/selection, theme, API key, workspace backup/merge/restore, and app version.
- `components/ConfigPanel.tsx`: system instructions, models, reasoning, verbosity, and tools.
- `components/TitleBar.tsx`: Electron-only window controls.
- `services/openaiService.generate.test.ts`: mocked-SDK contracts for request payloads, model/tool capabilities, attachment input parts, streaming/terminal output, cancellation/download endpoints, optional-capability retry behavior, and conversation history.
- `services/openaiService.test.ts`: citation marker recognition, annotation application, and redundant source-label cleanup.
- `services/storage.integration.test.ts`: public storage contracts against in-memory OPFS and IndexedDB, including v1 migration, immutable revisions, whole-generation recovery, pinned content, attachments, verified merge/restore/undo, backend migration, and Electron fallback refusal.
- `services/workspaceArchive.test.ts` and `services/backupScheduler.test.ts`: ZIP round trips and adversarial input, daily scheduling, close-time failure, corrupt-file handling, and retention.
- `utils/conversationExport.ts` and `utils/sourceUrls.ts`: Markdown transcript export and citation URL handling.
- `types.ts` and `constants.ts`: application/API types, model metadata, defaults, and configuration normalization.
- `electron/main.js`, `electron/preload.cjs`, and `electron/backupFiles.js`: Electron lifecycle, window assembly, narrow renderer IPC, folder configuration, backpressured archive writes, fsync/read-back verification, and atomic publication.
- `vite.config.ts` and `buildPolicy.test.ts`: build modes, secret injection policy, base paths, and generated PWA behavior.
- `index.html`, `index.css`, `tailwind.config.js`, and `postcss.config.js`: document shell and build-time Tailwind pipeline.
- `public/`: tracked static icons. `scripts/generate-icons.js` overwrites the generated PNG icon set.

Generated `node_modules/`, `dist/`, and `release/` content is ignored and should not be edited.

## Install And Commands

Use Node.js 22.12+ and install the lockfile exactly:

```bash
npm ci
```

On WSL, a non-interactive command runner may skip user shell initialization. If
an expected tool is missing or resolves to a Windows executable under `/mnt/c`,
do not conclude that the tool or project checks are unavailable. Compare its
resolution in the user's interactive login shell and run the affected command
through that environment. For this project, that shell initializes the native
NVM runtime under `/home/moctar/.nvm`:

```bash
bash -ilc 'command -v node && command -v npm && node --version && npm --version'
bash -ilc 'npm test'
```

In the Node example, the resolved `node` and `npm` paths should come from
`/home/moctar/.nvm/versions/node/.../bin`, not `/mnt/c`.

Ordinary finite local verification commands are:

- `npm test`: run the Vitest unit suite once.
- `npm run build`: TypeScript check plus Electron-mode Vite output in `dist/`.
- `npm run build:electron`: explicit equivalent of `npm run build`.
- `npm run build:web`: TypeScript check plus PWA-enabled web output in `dist/`.

There is no lint or format command. Vitest covers pure logic, server-rendered
component behavior, mocked-SDK generation, the App controller in `happy-dom`,
and storage through in-memory OPFS/IndexedDB doubles. The suite must not require
a live API key, real browser profile, real user storage, or Electron process.
Prefer fake timers and deferred promises over real waits.

Development servers are interactive, long-running processes:

- `npm run dev`: starts the web development server.
- `npm run preview`: serves the existing `dist/`; run `npm run build:web` first.
- `npm run electron:dev`: starts Vite and Electron and reserves port 5173.

The following commands have material side effects and are not ordinary
verification. Run them only when the task explicitly includes or authorizes
that effect:

- `npm run clean`: recursively removes `node_modules`, build/package output,
  and logs. Use `npm run clean -- --dry-run` to inspect targets first.
- `node scripts/generate-icons.js`: overwrites tracked PNG icons.
- `npm version patch|minor|major`: updates version files and creates a commit
  and Git tag by default.
- `npm run dist`: builds and packages host-platform Electron artifacts into
  `release/`.
- `npm run deploy`: builds the web app and publishes `dist/` through
  `gh-pages`.
- Live API smoke tests: consume account quota and create stored responses.

## Coding Conventions

- Use TypeScript and React functional components with hooks.
- Follow the existing 2-space indentation, semicolons, and single-quoted imports/strings.
- Use PascalCase for component files and components; use camelCase for functions and utilities.
- Keep state in `App.tsx` unless a component-local concern is genuinely isolated. Follow the current prop-driven data flow before adding a new state abstraction.
- Prefer the existing component, service, and utility boundaries. Avoid unrelated refactors.
- Prefer the simplest current design. Preserve backward compatibility only when removing it would break supported behavior, user data, or a viable upgrade path; do not retain legacy code or assumptions by default.
- When compatibility would add meaningful complexity, discuss the tradeoff and a migration toward the simpler end state with the user before implementation.
- Tailwind utilities are written inline and compiled at build time (Tailwind v4 through its dedicated PostCSS adapter; compatibility theme config in `tailwind.config.js`). Class names must appear as complete literal strings so automatic source detection can find them. Reserve `index.css` for global and complex reusable rules.
- Use `lucide-react` for UI icons and preserve accessible names/tooltips on icon-only controls.
- Keep fixed controls and responsive layouts stable at desktop and mobile widths. The mobile breakpoint in `App.tsx` is 768px.
- Add brief comments only for logic whose intent is not apparent from the code.
- Keep Responses API request, input, tool, usage, and stream-event types as aliases to the installed OpenAI SDK exports in `types.ts`. Do not introduce parallel hand-written API schemas.

## Implementation Contracts

Do not duplicate detailed implementation constraints here. Read and preserve the
applicable contracts in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md):

- Responses request construction, streaming, history, cancellation, titles,
  tools, attachments, citations, and generated files:
  [Responses API Contract](docs/IMPLEMENTATION.md#responses-api-contract).
- Persisted types, runtime validation, backend selection, immutable generations,
  migration, saves, and cross-tab ownership:
  [Persisted Data And Runtime Validation](docs/IMPLEMENTATION.md#persisted-data-and-runtime-validation),
  [Local Storage And Recovery](docs/IMPLEMENTATION.md#local-storage-and-recovery),
  and [Coordination And Save Invariants](docs/IMPLEMENTATION.md#coordination-and-save-invariants).
- Portable ZIP limits, merge semantics, recovery, undo, scheduling, retention,
  and Electron managed-file publication:
  [Portable Archive Contract](docs/IMPLEMENTATION.md#portable-archive-contract)
  and [Automatic Backup Contract](docs/IMPLEMENTATION.md#automatic-backup-contract).
- Web/PWA base policy, responsive behavior, Electron isolation/navigation, key
  handling, and privacy:
  [Web, PWA, Mobile, And Electron Constraints](docs/IMPLEMENTATION.md#web-pwa-mobile-and-electron-constraints)
  and [Security And Privacy Constraints](docs/IMPLEMENTATION.md#security-and-privacy-constraints).

For a persisted-field change, update the TypeScript type, configuration
normalization when relevant, every affected runtime parser, and the deliberate
compatibility or schema-version policy. Re-check IDs and cross-references and
extend schema, storage integration, and archive contracts as applicable.

Never commit API keys, real user data, or workspace exports. Local `.env*` files
are ignored; `.env.example` is explicitly allowed but is not currently present.
Never package or distribute a development key that Vite has inlined into the
renderer.

## Verification

Run the affected focused contracts before and during a change. The `test`
script is `vitest run`, so npm appends a test path after `--`:

```bash
npm test -- services/workspaceSchema.test.ts
npm test -- services/saveQueue.test.ts
npm test -- services/openaiService.generate.test.ts
npm test -- electron/urlPolicy.test.js
```

The task map above names the focused test for each extracted boundary. After
the focused checks pass, run the full suite and the builds appropriate to the
change. Record and report any pre-existing failure separately from failures
introduced by the change.

For shared React, TypeScript, service, storage, or configuration changes, run the unit suite and both build modes:

```bash
npm test
npm run build
npm run build:web
```

Then smoke-test the affected workflow. Use this risk-based matrix:

- UI changes: web at desktop and below 768px; check overflow, drawers/modals, keyboard send behavior, and light/dark themes.
- App request/state changes: extend `App.integration.test.tsx`; cover text deltas, authoritative completion metadata, cross-session routing, stop/failure, retry/regenerate, interrupted-request recovery, destructive operations, and close checkpointing.
- Attachment/tool/service changes: extend the mocked SDK contracts in `services/openaiService.generate.test.ts`; cover images, non-image files, citations, Code Interpreter output, generated-file downloads, optional-capability fallback, and history/thread construction.
- Storage changes: extend `services/storage.integration.test.ts` using only its in-memory backends; cover v1 migration, immutable object reuse, alternating-manifest failures, whole-generation fallback, both manifests corrupt, stale writers, hashes, bounded GC, pinning, blobs, recovery/undo, key semantics, backend migration, and injected failures.
- Archive/merge/scheduler changes: extend `services/workspaceArchive.test.ts`,
  `services/workspaceMerge.test.ts`, and `services/backupScheduler.test.ts`;
  cover binary round trips, merge collisions and ordering, imported blob
  selection, missing cached files, cancellation, limits, malformed/adversarial ZIPs, day rollover,
  unchanged-revision skip, writer/operation gating, retries, read-back failure,
  corrupt-file handling, and exactly-three-valid retention.
- PWA/config changes: keep `buildPolicy.test.ts` current, then run `npm run build:web` followed by `npm run preview`; inspect the `/openai-studio/` base, manifest, registration, and cached shell.
- Electron/preload changes: keep `electron/main.test.js` and
  `electron/backupFiles.test.js` current, then run `npm run electron:dev`;
  exercise window controls, clipboard behavior, external links, folder
  selection, partial cleanup, atomic backup publication, close backup
  Retry/Close Without Backup, and storage failure handling.
- Packaging changes: when packaging is explicitly in scope, run `npm run dist`
  on the target host with the required packaging/signing tooling.

When explicitly authorized, use a personal test key for live API smoke tests
and report which API-dependent paths were or were not exercised.

## Definition Of Done

A change is ready for handoff when:

- it starts at the narrowest existing boundary and avoids unrelated refactors;
- affected focused contracts pass, followed by the proportionate full suite and
  builds, with pre-existing failures reported separately;
- runtime behavior that tests cannot cover has been smoke-tested when practical;
- `docs/IMPLEMENTATION.md` and `README.md` have been updated when their contracts
  or user guidance changed, and links and referenced paths still resolve;
- no generated output, API keys, real user data, workspace exports, or unrelated
  worktree changes are included;
- the handoff reports verification, limitations, and any paths not exercised.

## Commits And Pull Requests

- Use short, imperative, descriptive commit subjects consistent with project history.
- Add a commit body for non-trivial changes. Explain the motivation, important
  behavioral changes, non-obvious decisions and tradeoffs, relevant constraints
  or rejected alternatives, and the validation performed. Do not merely restate
  changes that are already obvious from the diff.
- Subject-only commits are acceptable for trivial, self-explanatory changes.
- Keep commits scoped and avoid generated output or unrelated formatting churn.
- Pull requests should include a concise summary, verification notes, and screenshots or recordings for visible UI changes. Link related issues when applicable.
