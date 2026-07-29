# Repository Guidelines

This file is the canonical mutable contract for coding agents working in this
repository. Keep user and operator instructions in `README.md`; keep
tool-specific files such as `CLAUDE.md` limited to compatibility notes and
links back here rather than duplicating architecture, invariants, or commands.

## Project Overview

OpenAI Studio is a React 18 and TypeScript client for the OpenAI Responses API. Vite produces either a web/PWA bundle or an Electron renderer bundle. The OpenAI SDK runs directly in the renderer; there is no application server.

`index.tsx` mounts the application. `App.tsx` is the top-level controller and owns workspace loading, sessions, configuration, persistence, and active request state. State flows to functional components through props; the project has no router, React context, Redux-style store, or external state library.

The primary flow is:

```text
ChatArea user input -> App request/session state -> openaiService streaming API
                              |
                              +-> storage persistence
```

One request may run per session, while different sessions may stream concurrently.

## Task And Ownership Map

`App.tsx` is the state and workflow orchestrator: it composes the extracted
coordination helpers, storage facade, and API service. Keep locally testable
rules in their existing modules rather than expanding the controller.
`services/storage.ts` is the public persistence facade and composes schema,
backend, and atomic-snapshot modules. `services/openaiService.ts` is the
Responses API boundary for request construction, streaming, cancellation,
citations, and generated files.

Use this map to start a change at the narrowest boundary:

| Agent task | Canonical source | Focused contract |
| --- | --- | --- |
| Persisted JSON fields, portable backup validation, bounds, IDs, and references | `services/workspaceSchema.ts` | `services/workspaceSchema.test.ts`; add `services/storage.integration.test.ts` when the public storage flow changes |
| OPFS/IndexedDB selection and Electron fallback policy | `services/storageBackend.ts` | `services/storageBackend.test.ts` |
| All-or-rollback workspace snapshot commits | `services/atomicWorkspaceSnapshot.ts` | `services/atomicWorkspaceSnapshot.test.ts` |
| Cross-tab writer/reader ownership and reload coordination | `services/workspaceSync.ts` | `services/workspaceSync.test.ts` |
| Debounced, versioned, retried, and flushed saves | `services/saveQueue.ts` | `services/saveQueue.test.ts` |
| In-flight operation ownership and session/workspace invalidation | `services/operationRegistry.ts` | `services/operationRegistry.test.ts` |
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
- `components/Sidebar.tsx`: chat search/selection, theme, API key, workspace backup/restore, and app version.
- `components/ConfigPanel.tsx`: system instructions, models, reasoning, verbosity, and tools.
- `components/TitleBar.tsx`: Electron-only window controls.
- `services/openaiService.generate.test.ts`: mocked-SDK contracts for request payloads, model/tool capabilities, attachment input parts, streaming/terminal output, cancellation/download endpoints, optional-capability retry behavior, and conversation history.
- `services/openaiService.test.ts`: citation marker recognition, annotation application, and redundant source-label cleanup.
- `services/storage.integration.test.ts`: public storage contracts against in-memory OPFS and IndexedDB, including revisions, recovery, attachments, restore rollback, backend migration, and Electron fallback refusal.
- `utils/conversationExport.ts` and `utils/sourceUrls.ts`: Markdown transcript export and citation URL handling.
- `types.ts` and `constants.ts`: application/API types, model metadata, defaults, and configuration normalization.
- `electron/main.js` and `electron/preload.cjs`: Electron lifecycle, window assembly, IPC, and the narrow renderer bridge; `electron/main.test.js` covers their integration policy.
- `vite.config.ts` and `buildPolicy.test.ts`: build modes, secret injection policy, base paths, and generated PWA behavior.
- `index.html`, `index.css`, `tailwind.config.js`, and `postcss.config.js`: document shell and build-time Tailwind pipeline.
- `public/`: tracked static icons. `scripts/generate-icons.js` overwrites the generated PNG icon set.

Generated `node_modules/`, `dist/`, and `release/` content is ignored and should not be edited.

## Install And Commands

Use Node.js 20.19+ and install the lockfile exactly:

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
- Tailwind utilities are written inline and compiled at build time (Tailwind v3 through Vite's PostCSS pipeline; config in `tailwind.config.js`). Class names must appear as complete literal strings so the JIT content scan can find them. Reserve `index.css` for global and complex reusable rules.
- Use `lucide-react` for UI icons and preserve accessible names/tooltips on icon-only controls.
- Keep fixed controls and responsive layouts stable at desktop and mobile widths. The mobile breakpoint in `App.tsx` is 768px.
- Add brief comments only for logic whose intent is not apparent from the code.
- Keep Responses API request, input, tool, usage, and stream-event types as aliases to the installed OpenAI SDK exports in `types.ts`. Do not introduce parallel hand-written API schemas.

## Responses API Invariants

- `services/openaiService.ts` creates the SDK client in the renderer with `dangerouslyAllowBrowser: true`. The UI-supplied key takes precedence over `process.env.OPENAI_API_KEY`.
- Preserve the streamed lifecycle: create an assistant placeholder, record the ID from `response.created`, append `response.output_text.delta`, and parse `response.completed` for the authoritative final content and metadata.
- Automatic SDK retries are disabled for streamed generation and cancellation to avoid duplicate calls. Title generation and generated-file retrieval still use SDK defaults; coordinate any retry-policy changes with persisted request IDs and UI state.
- Stop generation attempts `responses.cancel(responseId)` when available, aborts the local stream, and retains partial content with `stopped` status.
- Persisted `pendingRequest` records are marked failed and retryable on the next startup. Preserve this recovery behavior when changing message state.
- Use `previous_response_id` only when the immediately preceding assistant message has an OpenAI response ID. In that case only the newest user turn is sent; otherwise send the local transcript.
- Requests intentionally use `store: true`, which supports response threading. A change to storage policy must also redesign continuation behavior and update user documentation.
- System prompts belong in top-level `instructions`. Images map to `input_image`; other readable attachments map to base64/data-URL `input_file` parts.
- Web Search currently sends a medium search context and a hard-coded approximate New York, US location. Code Interpreter uses an automatic container.
- Generated-file downloads require the in-app API key state plus both container and file IDs. An environment-only key can authorize requests but leaves the download controls unavailable.
- New-chat titles are a separate non-streaming GPT-5 Nano request.
- `thinkingDuration` is time to the first streamed text token, not total reasoning time or chain-of-thought duration.
- Citation post-processing helpers in `services/openaiService.ts` are pure and covered by `services/openaiService.test.ts`. Keep marker recognition, annotation replacement, source deduplication, and adjacent-label cleanup cases current when changing that pipeline.
- Model capability rules plus the identity and knowledge-cutoff metadata used to build the automatic instruction preamble live in `constants.ts`. Verify cutoff changes against the official model reference, keep the preamble ahead of user-selected custom instructions, and normalize saved configs when model options change so older workspaces remain loadable.

## Storage And Data Integrity

- Storage must load successfully before any writes are enabled. Do not allow initialization defaults to overwrite an unread workspace.
- Prefer OPFS. Browsers may fall back to IndexedDB, but Electron intentionally fails instead of silently opening an empty fallback store when OPFS is unavailable.
- The logical JSON files are `sessions.json`, `settings.json`, and `system_instructions.json`; attachment bytes live under `attachments/` or in separate IndexedDB records. Each changed JSON write preserves one `<filename>.bak` recovery copy.
- Keep malformed-primary recovery through the backup file. Schema and migration changes must tolerate older persisted data.
- Session writes use a 1-second trailing delay, a 5-second streaming checkpoint, and immediate request-boundary saves; settings and instructions use a 500 ms trailing delay. Writes are serialized and flushed on page suspension and through the Electron close handshake.
- Persisted sessions reference separate attachment blobs. Legacy embedded data URLs migrate on load, while workspace exports re-embed attachment data and can therefore still be large and sensitive.
- `services/workspaceSchema.ts` is the canonical strict runtime boundary for
  persisted JSON and portable workspace backups. It rejects unknown keys and
  unsupported values, enforces sizes and counts, validates IDs and
  cross-references, accepts an omitted `schemaVersion` for legacy backups,
  rejects a declared unsupported version, normalizes successful parses to the
  current version, and owns primary/`.bak` JSON parsing. Do not treat
  TypeScript types as sufficient validation.
- For a persisted-field change, update `types.ts` and
  `constants.ts`/configuration normalization when relevant, every affected
  runtime parser, and the deliberate backward-compatibility or
  `schemaVersion` policy. Re-check ID/reference validation and extend
  `services/workspaceSchema.test.ts`; add
  `services/storage.integration.test.ts` coverage when storage, recovery, or
  import/export behavior changes.
- Workspace export strips `settings.apiKey`, and restore ignores any key inside a backup file, preserving the workspace's current key. Import validates the supplied workspace through the strict schema and overwrites supplied sections only after confirmation.
- Chat deletion requires confirmation and has no undo. Preserve that risk in user-facing documentation unless the workflow changes.
- Browser persistence is origin-scoped. A different scheme, host, or port is a different workspace even if the path is the same.

## Web, PWA, And Electron Constraints

- Electron mode uses relative asset paths and disables the PWA plugin. Every non-Electron Vite mode currently uses the hard-coded `/openai-studio/` base.
- Generated PWA `scope` and `start_url` derive from `base`. For another hosting path, update `base`.
- `vite.config.ts` is authoritative for the generated PWA manifest and service worker.
- The PWA caches the built shell and selected assets, including the compiled Tailwind CSS, but model requests require connectivity. Google Fonts remain external and are runtime-cached by Workbox.
- `__APP_VERSION__` is read from `package.json` at build time.
- Electron uses a frameless single-instance window. `nodeIntegration` is off and `contextIsolation` is on; the preload bridge exposes only window controls, maximize state, and clipboard writes.
- Keep external navigation in the system browser and keep renderer IPC narrow. Electron's Chromium sandbox is currently disabled, which makes bridge and navigation discipline especially important.

## Security And Configuration

- Never commit API keys, real user data, or workspace exports. Local `.env*` files are ignored; `.env.example` is explicitly allowed but is not currently present.
- Development and Electron modes may inline `OPENAI_API_KEY` from Vite environment files into renderer JavaScript. Never package or distribute a developer key. Production web mode excludes the environment key.
- The Settings key is stored locally without application-level encryption but is excluded from workspace exports and ignored on import. Do not log it or expose it in diagnostics.
- This direct-client architecture is intended for user-owned keys. Do not add a shared deployment key without moving API calls behind an authenticated server.
- Prompts and attachments are sent to OpenAI, and requests use server-side response storage. Keep privacy claims and backup warnings accurate when behavior changes.

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
- Storage changes: extend `services/storage.integration.test.ts` using only its in-memory backends; cover first load, revisions, backup recovery, attachments, atomic restore, export/import key semantics, backend migration, and injected failures. Then smoke-test checkpointed persistence, lifecycle/close flushing, and reload.
- PWA/config changes: keep `buildPolicy.test.ts` current, then run `npm run build:web` followed by `npm run preview`; inspect the `/openai-studio/` base, manifest, registration, and cached shell.
- Electron/preload changes: keep `electron/main.test.js` current, then run `npm run electron:dev`; exercise window controls, clipboard behavior, external links, close-save failure handling, and storage failure handling.
- Packaging changes: when packaging is explicitly in scope, run `npm run dist`
  on the target host with the required packaging/signing tooling.

When explicitly authorized, use a personal test key for live API smoke tests
and report which API-dependent paths were or were not exercised.

## Commits And Pull Requests

- Use short, imperative, descriptive commit subjects consistent with project history.
- Keep commits scoped and avoid generated output or unrelated formatting churn.
- Pull requests should include a concise summary, verification notes, and screenshots or recordings for visible UI changes. Link related issues when applicable.
