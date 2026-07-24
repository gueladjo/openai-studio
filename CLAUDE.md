# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` covers the same ground in more depth (full verification matrix, commit/PR conventions). Keep the two consistent when updating either.

## Project Overview

OpenAI Studio is a React 18 + TypeScript client for the OpenAI Responses API (GPT-5.x series and o3). Vite produces either a web/PWA bundle or an Electron renderer bundle. There is no application server: the OpenAI SDK runs directly in the browser/Electron renderer with a user-supplied API key, and all data persists client-side (OPFS, with IndexedDB fallback in browsers).

## Commands

```bash
npm ci                          # Install exact lockfile deps (Node 20.19+)
npm run dev                     # Web dev server → http://localhost:5173/openai-studio/
npm test                        # Run the Vitest unit suite once
npm run electron:dev            # Vite (electron mode) + Electron; main process expects port 5173
npm run build                   # tsc + Electron-mode bundle → dist/ (alias: build:electron)
npm run build:web               # tsc + web/PWA bundle → dist/
npm run preview                 # Serve existing dist/ → http://localhost:4173/openai-studio/ (run build:web first)
npm run dist                    # Electron build + host-platform installer → release/
npm run deploy                  # build:web + gh-pages -d dist
node scripts/generate-icons.js  # Regenerate PNG icons (no npm alias)
```

There is no lint or format command. Vitest covers pure logic, server-rendered component behavior, and mocked-SDK generation behavior without requiring a browser or live API setup.

## Architecture

**State**: centralized in `App.tsx` with `useState`; flows to functional components via props. No router, context, Redux, or external state library. One in-flight request per session, but different sessions can stream concurrently (per-request `AbortController` map). Mobile breakpoint is 768px.

**Data flow**:
```
User input (ChatArea) → App.tsx state → openaiService.ts (streaming) → OpenAI Responses API
                            ↓
                  storage.ts (OPFS/IndexedDB, coordinated writes)
```

**Repository map**:
- `App.tsx` — all state, storage init, serialized/checkpointed saves, request lifecycle (send/stop/retry/regenerate), import/export
- `components/ChatArea.tsx` — composer, attachments, message rendering, response details, citations, generated files
- `components/Sidebar.tsx` — session list/search, theme, API key modal, workspace backup/restore, app version
- `components/ConfigPanel.tsx` — model, reasoning effort, verbosity, tools, system instructions
- `components/TitleBar.tsx` — Electron-only window controls
- `services/openaiService.ts` — SDK integration: streaming, cancellation, response threading, citations, generated-file retrieval, title generation
- `services/openaiService.generate.test.ts` — mocked-SDK reasoning-summary streaming, optional-capability retry, and conversation-history tests
- `services/openaiService.test.ts` — citation marker, annotation application, source deduplication, and source-label cleanup tests
- `services/storage.ts` — OPFS/IndexedDB abstraction, `.bak` recovery, workspace backup/restore
- `utils/conversationExport.ts` — Markdown transcript export (the chat "Share" button downloads a local file; it does not publish)
- `utils/sourceUrls.ts` — citation URL validation and display metadata
- `types.ts` — app types + Responses API SDK aliases; `constants.ts` — model catalog, defaults, config normalization
- `electron/main.js` / `electron/preload.cjs` — Electron lifecycle and the narrow IPC bridge
- `vite.config.ts` — mode-specific base paths, env injection, `__APP_VERSION__`, and the authoritative generated PWA manifest/service worker
- `vitest.config.ts` — Node unit-test environment and test-only `__APP_VERSION__` definition

## Key Types (types.ts)

```typescript
enum ModelId { GPT_5_6_SOL, GPT_5_6_TERRA, GPT_5_5, GPT_5_MINI, GPT_5_NANO, GPT_O3 }  // values are API model strings

interface ChatConfig {
  model: ModelId;
  reasoningEffort: string;  // per family: GPT-5.6 none..xhigh+max; GPT-5.5 none..xhigh; mini/nano minimal..high; o3 low..high
  textVerbosity: 'low' | 'medium' | 'high';  // o3 does not support verbosity
  tools: { webSearch: boolean; codeInterpreter: boolean };
  systemInstructionId?: string;
}

interface Session { id, title, messages: Message[], config: ChatConfig, lastModified, pendingRequest? }
interface Message {
  role, content, timestamp,
  status?,                       // 'streaming' | 'complete' | 'error' | 'stopped' — drives partial render, retry, regenerate
  requestId?, openaiResponseId?,
  thinking?, thinkingDuration?,  // thinkingDuration = ms to first streamed text token, NOT total reasoning time
  usage?, sources?, generatedFiles?, attachments?, model?, reasoningEffort?
}
```

Responses request/input/tool/usage/stream-event types in `types.ts` must stay aliased to the installed OpenAI SDK exports from `openai/resources/responses/responses` — never re-declare parallel API schemas. (`max` effort is cast because openai@6.x typings don't list it yet.)

## Responses API Invariants (openaiService.ts)

- The SDK client is created per request in the renderer with `dangerouslyAllowBrowser: true`. The UI-entered key takes precedence over `process.env.OPENAI_API_KEY`.
- Streamed generation and cancellation use `maxRetries: 0` (prevents duplicate calls) and a 1-hour timeout. Title generation and generated-file retrieval keep SDK default retries — coordinate any retry-policy change with persisted request IDs and UI state.
- Streamed lifecycle: create an assistant placeholder → record the ID from `response.created` (enables cancel) → append `response.output_text.delta` → parse `response.completed` as the authoritative final content, citations, usage, and generated files.
- `previous_response_id` is used only when the immediately preceding assistant message has an `openaiResponseId`; then only the newest user turn is sent. Otherwise the full local transcript is sent.
- Requests intentionally use `store: true` — response threading depends on it. Changing storage policy means redesigning continuation and updating user docs.
- System prompts go in top-level `instructions`. Images map to `input_image`; other attachments with content map to base64 data-URL `input_file` parts; attachments without content degrade to a filename note in the text.
- Stop generation calls `responses.cancel(responseId)` when available, aborts the local stream, and keeps partial content with `stopped` status.
- Persisted `pendingRequest` records are marked failed and retryable on next startup — preserve this recovery when changing message state.
- New-chat titles are a separate non-streaming GPT-5 Nano request (minimal effort, low verbosity).
- Web Search sends a hard-coded approximate New York, US location and `search_context_size: 'medium'`. Code Interpreter uses an auto container.
- Generated-file downloads need both container and file IDs plus the in-app key state; an env-only key can authorize API calls but leaves download controls unavailable.
- Citation post-processing helpers in `services/openaiService.ts` are pure and covered by `services/openaiService.test.ts`; update the marker, annotation, deduplication, and adjacent-label cases with any pipeline change.
- Model capability rules live in `constants.ts` (`MODEL_CONFIGS`); `normalizeChatConfig` keeps older saved workspaces loadable — update it whenever model options change. Default config: GPT-5.6 Sol, medium effort/verbosity, Web Search on.

## Storage & Data Integrity (storage.ts, App.tsx)

- Storage must load successfully before writes are enabled (`isWorkspaceLoaded` gates `scheduleSave`). Never let initialization defaults overwrite an unread workspace.
- Backend selection: OPFS preferred (logical `data/` directory); browsers fall back to the `openai-studio-storage` IndexedDB database; Electron intentionally throws instead of silently opening an empty fallback store.
- Logical JSON files: `sessions.json`, `settings.json`, `system_instructions.json`. Each changed write preserves one `<filename>.bak`; a malformed primary is recovered from its backup. Schema changes must tolerate older persisted data.
- Session writes have a 1s trailing delay, a 5s streaming checkpoint, and immediate request-boundary saves. Settings/instructions retain a 500ms trailing delay. Writes are serialized and flushed on page suspension and through an Electron close handshake.
- Attachment bytes persist separately under `attachments/` (or separate IndexedDB records); `sessions.json` stores IDs and metadata. Legacy embedded data URLs migrate on load. Workspace exports deliberately re-embed attachment data so the JSON backup stays portable and sensitive.
- Workspace export strips `settings.apiKey`; restore ignores any key inside the backup file and keeps the workspace's current key. Import validates core session/message/attachment, instruction, and settings shapes, then overwrites the supplied sections after confirmation.
- Chat deletion requires confirmation and has no undo.
- Persistence is origin-scoped: a different scheme, host, or port is a different workspace.

## Build Modes, PWA, Electron

- Vite `electron` mode: relative base `./`, PWA plugin disabled. All other modes: hard-coded base `/openai-studio/` (matches GitHub Pages). Generated PWA `scope`/`start_url` derive from `base` — deploying elsewhere means changing `base`.
- `__APP_VERSION__` is injected from `package.json` at build time; bump with `npm version patch|minor|major` before a release.
- The PWA caches the built shell, including the compiled Tailwind CSS; model requests require connectivity. Google Fonts remain external and runtime-cached by Workbox (Electron falls back to system fonts when offline cold).
- Electron: frameless single-instance window, `nodeIntegration` off, `contextIsolation` on, Chromium sandbox currently disabled — keep the preload bridge narrow (window controls, maximize state, clipboard) and external navigation in the system browser.

## Security

- Never commit API keys, real user data, or workspace exports. `.env*` files are ignored.
- Development and Electron modes inline `OPENAI_API_KEY` from Vite env files into renderer JavaScript — never package or publish a build carrying a developer key. Production web mode excludes the env key; users enter their own in Settings.
- The Settings key is stored unencrypted in `settings.json` but excluded from workspace exports and ignored on import. Do not log it or surface it in diagnostics.
- This direct-client architecture is for user-owned keys; a shared deployment key would require moving API calls behind an authenticated server.

## Styling & Conventions

- Tailwind CSS v3 compiled at build time (`tailwind.config.js` + `postcss.config.js`, processed through Vite); utilities written inline. Class names must appear as complete literal strings — the JIT content scan cannot see names built from fragments. `index.css` opens with the `@tailwind` directives; reserve it for globals and complex reusable rules.
- Dark mode: `.dark` class on root + `dark:` variants. Fonts: Inter (sans), JetBrains Mono (code). Icons: `lucide-react`, with accessible names/tooltips on icon-only controls.
- 2-space indent, semicolons, single quotes; PascalCase components, camelCase functions/utilities.
- Keep state in `App.tsx` unless genuinely component-local; follow the existing prop-driven flow and component/service/utility boundaries. Comments only for non-obvious intent.

## Verification

For shared React/TypeScript/service/storage/config changes, run the unit suite and both build modes:

```bash
npm test && npm run build && npm run build:web
```

Then smoke-test the affected area: UI → desktop and <768px widths, both themes; streaming → deltas, stop, retry, regenerate, mid-stream session switches, interrupted-request recovery; attachments/tools → images, files, citations, Code Interpreter output, generated-file downloads; storage → first load, reload, backup recovery, export/import; PWA → `build:web` + `preview`; Electron → `electron:dev` window controls, clipboard, external links. Live API smoke tests consume quota and create stored responses — use a personal test key and report any API-dependent paths not exercised.
