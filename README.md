# OpenAI Studio

OpenAI Studio is a React and TypeScript client for the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses). It runs as a Vite web/PWA application or an Electron desktop application, streams responses directly from OpenAI, and keeps workspace state in client-managed storage.

This project has no application server. The OpenAI SDK runs in the browser or Electron renderer with the API key supplied by the user.

See the [implementation specification](docs/IMPLEMENTATION.md) for canonical
architecture, intended behavior, invariants, and acceptance criteria. Contributors
and coding agents should start with [AGENTS.md](AGENTS.md) for repository working
rules, task routing, and verification commands.

## Features

- Streaming Responses API conversations with stop, failed-turn retry, and latest-response regenerate controls.
- Independent in-flight requests across sessions, so a response can continue while another chat is open.
- Configured model picker for GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5, GPT-5 Nano, and o3. Model availability depends on the API account.
- Model-specific reasoning effort and text verbosity controls.
- Automatic model identity and knowledge-cutoff preambles, followed by any reusable system instruction selected by the user and applied through the Responses API `instructions` field.
- Optional Web Search and Code Interpreter tools.
- Multiple image and file attachments, including files pasted from the clipboard.
- GitHub Flavored Markdown, code blocks, tables, citations, generated Code Interpreter files, and response copying.
- Per-response model, reasoning effort, time-to-first-token, and token-usage details. Model names are captured with each answer, so later catalog changes do not relabel conversation history.
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

- Node.js 22 or newer and npm.
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

Workspace changes save automatically after the workspace loads successfully.
Storage behavior depends on the runtime:

| Runtime | Backend behavior |
| --- | --- |
| Browser with OPFS | Uses a sandboxed logical `data/` directory. |
| Browser without OPFS | Uses the `openai-studio-storage` IndexedDB database. |
| Electron | Requires OPFS; it does not switch to an empty IndexedDB workspace if OPFS fails. |

Browser workspaces are origin-scoped: changing the scheme, host, or port opens a
different workspace even when the path is unchanged. If storage cannot be loaded
or safely selected, the app reports the problem instead of opening an empty
fallback workspace.

The Settings workspace actions are:

- **Backup** creates an integrity-checked ZIP containing conversations, custom
  instructions, attachments, and locally cached generated files. It excludes
  the API key and device-local backup preferences.
- **Restore** validates the selected ZIP and shows a preview before replacing
  the workspace. The current device's API key is preserved.
- **Merge** starts after file selection without a separate preview or
  confirmation. It preserves current settings and chats, skips identical chats,
  and keeps conflicting archived chats as remapped copies.
- **Undo last restore** or **Undo last merge** reverses only the latest
  successful workspace mutation and is single-use.

Legacy JSON exports are deliberately unsupported. Archives are unencrypted and
can contain sensitive prompts, responses, instructions, and file data.

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

## Contributing

The [implementation specification](docs/IMPLEMENTATION.md) describes the
current architecture, intended behavior, failure contracts, and acceptance-test
traceability. [AGENTS.md](AGENTS.md) provides the task-to-module map, command
safety rules, focused test selection, and definition of done.

For shared TypeScript or React changes, the ordinary finite checks are:

```bash
npm test
npm run build
npm run build:web
```

Run the focused contracts named in `AGENTS.md` while iterating, then the complete
suite and affected builds before handoff. Keep tests isolated from live API
quota, real browser storage, real user data, and workspace exports. Record
pre-existing failures separately.
