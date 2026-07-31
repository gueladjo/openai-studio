# OpenAI Studio

OpenAI Studio is a React and TypeScript client for the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses). It runs as a Vite web/PWA application or an Electron desktop application, streams responses directly from OpenAI, and keeps workspace state in client-managed storage.

This project has no application server. The OpenAI SDK runs in the browser or Electron renderer with the API key supplied by the user.

## Features

- Streaming Responses API conversations with stop, failed-turn retry, and latest-response regenerate controls.
- Independent in-flight requests across sessions, so a response can continue while another chat is open.
- Configured model picker for GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5, GPT-5 Nano, and o3. Model availability depends on the API account.
- Model-specific reasoning effort and text verbosity controls.
- Automatic model identity and knowledge-cutoff preambles, followed by any reusable system instruction selected by the user and applied through the Responses API `instructions` field.
- Optional Web Search and Code Interpreter tools.
- Multiple image and file attachments, including files pasted from the clipboard.
- GitHub Flavored Markdown, code blocks, tables, citations, generated Code Interpreter files, and response copying.
- Per-response model, reasoning effort, time-to-first-token, and token-usage details.
- Local chat-title search with light and dark themes.
- Checksummed ZIP workspace backup/merge/restore, opt-in daily folder backups, action-aware merge/restore undo, and per-conversation Markdown export.
- Responsive mobile layout, installable PWA output, and Electron desktop packaging.

## Security And Data

OpenAI Studio is a direct client, not a local-only inference application:

- Prompts, attachments, and instructions are sent to OpenAI. Generated responses are returned by OpenAI and retained server-side when response storage is enabled.
- Responses API requests use `store: true` so conversations can continue with `previous_response_id`. New-chat title generation also creates a stored API response.
- The API key entered in Settings is stored in the local workspace settings object and is not encrypted by this project.
- A portable ZIP includes conversations, system instructions, attachments, and locally cached generated files, but never the API key or device-local backup preferences. Restoring keeps the current device's key. Archives are not encrypted and can contain sensitive content.
- Browser storage is scoped to the origin. Clearing site data, removing the desktop app's user data, or changing origins can make the workspace unavailable.

Do not put a shared or production API key into a publicly deployed build. Each user should enter their own key in Settings.

## Prerequisites

- Node.js 20.19 or newer and npm.
- An OpenAI API key with access to the selected models and tools.
- A modern browser for the web app. The app prefers OPFS and falls back to IndexedDB outside Electron.

## Quick Start

Install the locked dependencies:

```bash
npm ci
```

Start the web development server:

```bash
npm run dev
```

Open `http://localhost:5173/openai-studio/`. Vite provides hot module replacement; a production build is not required for normal development.

Create a chat, open Settings from the bottom of the sidebar, and enter an API key. The value entered in Settings takes precedence over an environment key.

On WSL, a non-interactive command runner may skip user shell initialization. If
an expected tool is missing or resolves to a Windows executable under `/mnt/c`,
compare its resolution in the user's interactive login shell and run the
affected command through that environment. For this project, doing so
initializes the native NVM runtime:

```bash
bash -ilc 'command -v node && command -v npm && node --version && npm --version'
bash -ilc 'npm run dev'
```

### Optional Local Environment Key

For local development or Electron development, an ignored `.env.local` file can provide a convenience key:

```dotenv
OPENAI_API_KEY=sk-...
```

Development and Electron modes compile this value into renderer JavaScript. Do not use this mechanism for a build that will be packaged, published, or shared. Production web mode intentionally excludes `OPENAI_API_KEY`; users must enter it in the UI. Generated files are cached locally after a response when possible; cached copies remain downloadable without a key, while an uncached download requires the key in Settings.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the exact dependency versions from `package-lock.json`. |
| `npm run clean` | Remove generated dependencies, build/package output, and log files. Add `-- --dry-run` to preview the targets. |
| `npm run dev` | Start the web dev server at `/openai-studio/`. |
| `npm test` | Run the Vitest unit suite once. |
| `npm run electron:dev` | Start Vite in Electron mode and launch Electron against it on port 5173. |
| `npm run build` | Typecheck and create an Electron-mode bundle in `dist/`. |
| `npm run build:electron` | Explicit alias for the Electron-mode build. |
| `npm run build:web` | Typecheck and create the web/PWA bundle in `dist/`. |
| `npm run preview` | Serve the existing `dist/` directory; run `build:web` first for PWA verification. |
| `npm run dist` | Build and package the configured Electron target into `release/`. |
| `npm run deploy` | Build the web app and publish `dist/` with `gh-pages`. |
| `node scripts/generate-icons.js` | Regenerate the PNG application icons. |

The Vitest suite is deterministic and does not require a live API key, browser
profile, OPFS directory, or Electron process. It covers the App request
lifecycle, Responses API payloads and stream parsing, storage and migration
contracts, build security policy, Electron window policy, and focused utility
and component behavior. There is currently no lint or format script.

## Web And PWA

Create and preview a production PWA build:

```bash
npm run build:web
npm run preview
```

Open `http://localhost:4173/openai-studio/`. The preview command serves the current contents of `dist/`; it does not rebuild after source changes.

The web base path is configured in `vite.config.ts` as `/openai-studio/`, matching this repository's GitHub Pages path. The generated PWA `scope` and `start_url` derive from `base`. When deploying under another repository path or at a domain root, change `base`.

Deploy the PWA over HTTPS. Localhost is treated as a secure context for development and preview, but service workers are not available from an ordinary HTTP production origin.

Deploy the current web build to the configured `gh-pages` destination with:

```bash
npm run deploy
```

The service worker caches the application shell and selected assets, including
the Tailwind CSS compiled at build time through PostCSS. Google Fonts remain
external and are runtime-cached by Workbox. OpenAI requests still require a
network connection, so installation does not make model features available
offline.

## Electron

Run the desktop application in development:

```bash
npm run electron:dev
```

Electron development expects Vite on port 5173. Stop any process already using that port before starting the command.

Package the application for the current host platform:

```bash
npm run dist
```

Electron Builder writes host-platform output to `release/`. This repository explicitly configures NSIS on Windows and AppImage on Linux; macOS uses Electron Builder's default target because no macOS target is specified. Cross-platform packaging and code signing may require additional host tooling and credentials.

The version displayed in Settings is compiled from `package.json`. Advance it with `npm version patch`, `npm version minor`, or `npm version major` as appropriate before a release.

## Persistence And Backups

`services/storage.ts` selects the storage backend at startup:

| Runtime | Backend behavior |
| --- | --- |
| Browser with OPFS | Uses a sandboxed logical `data/` directory. |
| Browser without OPFS | Uses the `openai-studio-storage` IndexedDB database. |
| Electron | Requires OPFS; it does not switch to an empty IndexedDB workspace if OPFS fails. |

Local persistence uses immutable, content-addressed generations:

- Two alternating `workspace_manifest_a.json` / `workspace_manifest_b.json` records point to complete generations.
- Each session, settings object, and instruction list is stored under its SHA-256 hash in `objects/`.
- Attachment and cached generated-file bytes share `blobs/<sha256>`.
- Startup validates each manifest, every referenced object, every referenced blob, and all schema/cross-reference rules. It selects the highest complete revision or falls back to the previous complete manifest as a unit.
- Saves write and verify new objects first, publish the other manifest slot last, reuse unchanged objects, and garbage-collect content not retained by the two valid manifests or an active pinned backup read.

The first load migrates the previous `sessions.json`, `settings.json`, `system_instructions.json`, and `attachments/` layout only after the new generation reads back successfully. The legacy records are retained during that verification, so a failed migration cannot open an empty workspace.

Session writes keep the one-second trailing delay and five-second streaming checkpoint; request boundaries save immediately. Settings and instructions use a 500 ms delay. Writes remain serialized and are flushed on suspension and through the Electron close handshake.

Portable backups are standard `.zip` archives containing a strict `manifest.json`, separate JSON entries, and raw content-addressed blobs. Every entry declares its byte length and SHA-256 digest. Restore and Merge reject extra, missing, duplicate, case-colliding, traversal, oversized, truncated, or digest-mismatched entries before changing the workspace. Restore shows a verified-backup preview; Merge starts immediately after file selection and imports whole chats without a preview or confirmation. Legacy JSON exports are deliberately unsupported.

Merge preserves the current theme, API key, active-chat selection, chats, and custom instructions. Identical chats are skipped. A differing archived chat with the same ID is kept as a separate copy with remapped local session, message, request, pending-request, and attachment IDs; external OpenAI response and generated-file IDs are retained. Referenced custom instructions are reused when identical and remapped when their IDs conflict. Unreferenced archived instructions and blobs belonging only to skipped chats are not imported. The resulting Recent list remains newest-first, with current-workspace chats before archived chats when timestamps tie.

Before replacement or merge publication, the app creates and reads back a verified internal recovery archive. The operation aborts without publishing a generation if validation, recovery, limits, blob staging, or commit fails. Settings exposes action-aware **Undo last restore** or **Undo last merge** for the latest successful workspace mutation. Undo is single-use. Restore preserves the current API key; Merge preserves all current settings.

Compatible Chromium browsers and Electron can opt into automatic backups by choosing a folder. Automatic backups:

- are disabled by default;
- run at the next eligible foreground opportunity, at most once per local day;
- skip unchanged persisted revisions and run only in the writer tab;
- pause for responses, generated-file caching, destructive operations, or renewed folder permission;
- verify a newly written archive before rotation and retain the three newest valid managed archives;
- never delete unrelated files in the selected folder.

Electron waits for a due backup during close and offers Retry or Close Without Backup on failure. Browsers without the File System Access directory picker, including the iOS path, retain **Backup** (Share when available, download otherwise), **Merge**, and **Restore**. Browser folder handles and scheduler history are device-local and excluded from archives.

The chat header's Share button does not publish a link; it downloads a local Markdown file containing message text. That file omits response details, sources, generated-file references, and attachment data, using a placeholder only for attachment-only messages. Remote generated files can expire before caching succeeds, and archives report how many generated-file references lack local bytes.

Chat deletion asks for confirmation and has no in-app undo. Export the workspace before destructive cleanup.

## Architecture

```text
ChatArea user input -> App request/session state -> openaiService streaming API
                              |
                              +-> storage persistence
```

`App.tsx` owns application state and orchestrates save, workspace-coordination,
and operation state. `components/ChatArea.tsx` owns per-session composer drafts
through `utils/chatDrafts.ts`.
`services/storage.ts` is the OPFS/IndexedDB persistence facade.
`services/workspaceGenerationStore.ts` owns immutable generation publication,
whole-generation validation, pinning, and garbage collection.
`services/workspaceArchive.ts`, `services/workspaceMerge.ts`,
`services/workspaceRestore.ts`,
`services/backupDestination.ts`, and `services/backupScheduler.ts` own portable
ZIP integrity, chat merge/collision handling, recovery/undo, folder
capabilities, retention, and scheduling.
`services/openaiService.ts` constructs Responses API requests, streams text,
and handles response metadata and generated files. See
[AGENTS.md](AGENTS.md) for the canonical contributor task-to-module and
focused-test map.

## Development Verification

Before submitting a change, run the unit suite and the mode-specific builds the change affects. For shared TypeScript or React changes, run all three:

```bash
npm test
npm run build
npm run build:web
```

Use targeted Vitest files while iterating:

```bash
npm test -- services/workspaceSchema.test.ts
npm test -- services/openaiService.generate.test.ts
npm test -- App.integration.test.tsx
```

Then run the complete suite and affected builds before handoff. The default
environment is Node; `App.integration.test.tsx` opts into
`happy-dom`, mocks its child components and I/O boundaries, and uses fake
timers. `services/storage.integration.test.ts` uses an in-memory OPFS plus
`fake-indexeddb`. Keep those tests isolated from real user storage and never put
a real API key or workspace export into a fixture. Record and report
pre-existing failures separately.

When changing a protected boundary, update its contract suite:

- `App.integration.test.tsx`: startup write protection, pending-request
  recovery, cross-session routing, stop/failure behavior, destructive races,
  and Electron close persistence.
- `services/openaiService.generate.test.ts`: SDK payloads, model capabilities,
  attachment parts, streaming events, cancellation, titles, and generated
  files.
- `services/storage.integration.test.ts`: v1 migration, immutable revisions,
  whole-generation fallback, pinned content, recovery/undo, attachment/key
  handling, backend migration, and rollback.
- `services/workspaceArchive.test.ts` and `services/backupScheduler.test.ts`:
  ZIP integrity/path policy, binary round trips, legacy rejection, daily
  scheduling, close failures, corruption handling, and three-file retention.
- `electron/backupFiles.test.js`: managed filename validation, streamed writes,
  fsync/read-back verification, atomic rename, and stale-partial cleanup.
- `electron/main.test.js` and `buildPolicy.test.ts`: renderer/navigation/close
  policy and production build secret/base-path policy.
- `services/openaiService.test.ts`: citation markers, annotation replacement,
  source ordering and deduplication, adjacent-label cleanup, and malformed
  annotations.

Smoke-test the web UI at desktop and mobile widths. Changes to Electron, persistence, PWA behavior, streaming, cancellation, attachments, or import/export should also be exercised in the corresponding runtime.
