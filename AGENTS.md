# Repository Guidelines

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

## Repository Map

- `index.tsx`: React bootstrap.
- `App.tsx`: central state, storage initialization, serialized/checkpointed saves, response lifecycle, stop/retry/regenerate, and import/export.
- `components/ChatArea.tsx`: composer, attachments, message rendering, response details, citations, generated files, and conversation Markdown export.
- `components/Sidebar.tsx`: chat search/selection, theme, API key, workspace backup/restore, and app version.
- `components/ConfigPanel.tsx`: system instructions, models, reasoning, verbosity, and tools.
- `components/TitleBar.tsx`: Electron-only window controls.
- `services/openaiService.ts`: OpenAI SDK integration, stream parsing/cancellation, response threading, citations, and generated-file retrieval.
- `services/openaiService.generate.test.ts`: mocked-SDK Vitest coverage for reasoning-summary streaming, optional-capability retry behavior, and conversation-history construction.
- `services/openaiService.test.ts`: Vitest coverage for citation marker recognition, annotation application, and redundant source-label cleanup.
- `services/storage.ts`: OPFS/IndexedDB abstraction, separate attachment records, rolling backups, and workspace backup/restore.
- `utils/conversationExport.ts`: Markdown transcript export and filename handling.
- `utils/sourceUrls.ts`: citation URL validation and display metadata.
- `types.ts`: application types plus aliases to Responses API SDK types.
- `constants.ts`: model catalog, defaults, and config normalization.
- `electron/main.js` and `electron/preload.cjs`: Electron lifecycle, window policy, IPC, and the narrow renderer bridge.
- `vite.config.ts`: mode-specific base paths, environment injection, app version, and authoritative generated PWA configuration.
- `vitest.config.ts`: Node unit-test environment plus the test-only app-version definition.
- `index.html` and `index.css`: document shell and font links; `index.css` opens with the `@tailwind` directives and holds global/custom CSS. `tailwind.config.js` and `postcss.config.js` drive the build-time Tailwind pipeline.
- `public/`: static icons. `scripts/generate-icons.js` regenerates PNG icons.

Generated `node_modules/`, `dist/`, and `release/` content is ignored and should not be edited.

## Install And Commands

Use Node.js 20.19+ and install the lockfile exactly:

```bash
npm ci
```

- `npm run dev`: web dev server at `http://localhost:5173/openai-studio/`.
- `npm test`: run the Vitest unit suite once.
- `npm run electron:dev`: Vite in Electron mode plus Electron. The Electron main process is fixed to port 5173.
- `npm run build`: TypeScript check plus Electron-mode Vite output in `dist/`.
- `npm run build:electron`: explicit equivalent of `npm run build`.
- `npm run build:web`: TypeScript check plus PWA-enabled web output in `dist/`.
- `npm run preview`: serves the existing `dist/`; run `npm run build:web` first and open `http://localhost:4173/openai-studio/`.
- `npm run dist`: Electron build plus host-platform packaging into `release/`.
- `npm run deploy`: web build plus `gh-pages -d dist`.
- `node scripts/generate-icons.js`: regenerate application icons; there is no npm alias.

There is no lint or format command. Vitest covers pure logic, server-rendered component behavior, and mocked-SDK generation behavior without requiring a browser or live API setup.

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
- Workspace export strips `settings.apiKey`, and restore ignores any key inside a backup file, preserving the workspace's current key. Import performs only basic shape validation and overwrites supplied workspace sections after confirmation. Strengthen validation before trusting new fields.
- Chat deletion is immediate with no confirmation or undo. Preserve that risk in user-facing documentation unless the workflow changes.
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

For shared React, TypeScript, service, storage, or configuration changes, run the unit suite and both build modes:

```bash
npm test
npm run build
npm run build:web
```

Then smoke-test the affected workflow. Use this risk-based matrix:

- UI changes: web at desktop and below 768px; check overflow, drawers/modals, keyboard send behavior, and light/dark themes.
- Streaming changes: text deltas, completion metadata, switching sessions mid-stream, stop, retry, regenerate, and interrupted-request recovery.
- Attachment/tool changes: images, non-image files, citations, Code Interpreter output, and generated-file downloads.
- Storage changes: first load, checkpointed persistence, lifecycle/close flushing, reload, malformed-primary backup recovery, attachment migration, JSON export, and confirmed import replacement.
- PWA changes: `npm run build:web` followed by `npm run preview`; inspect the `/openai-studio/` base, manifest, registration, and cached shell.
- Electron/preload changes: `npm run electron:dev`; exercise window controls, clipboard behavior, external links, and storage failure handling.
- Packaging changes: `npm run dist` on the target host when the required packaging/signing tooling is available.

Live API smoke tests consume account quota and can create stored responses. Use a personal test key and report when API-dependent paths were not exercised.

## Commits And Pull Requests

- Use short, imperative, descriptive commit subjects consistent with project history.
- Keep commits scoped and avoid generated output or unrelated formatting churn.
- Pull requests should include a concise summary, verification notes, and screenshots or recordings for visible UI changes. Link related issues when applicable.
