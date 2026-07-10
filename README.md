# OpenAI Studio

OpenAI Studio is a React and TypeScript client for the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses). It runs as a Vite web/PWA application or an Electron desktop application, streams responses directly from OpenAI, and keeps workspace state in client-managed storage.

This project has no application server. The OpenAI SDK runs in the browser or Electron renderer with the API key supplied by the user.

## Features

- Streaming Responses API conversations with stop, failed-turn retry, and latest-response regenerate controls.
- Independent in-flight requests across sessions, so a response can continue while another chat is open.
- Configured model picker for GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.5, GPT-5 Mini, GPT-5 Nano, and o3. Model availability depends on the API account.
- Model-specific reasoning effort and text verbosity controls.
- Reusable system-instruction library, applied through the Responses API `instructions` field.
- Optional Web Search and Code Interpreter tools.
- Multiple image and file attachments, including files pasted from the clipboard.
- GitHub Flavored Markdown, code blocks, tables, citations, generated Code Interpreter files, and response copying.
- Per-response model, reasoning effort, time-to-first-token, and token-usage details.
- Local chat-title search with light and dark themes.
- Full workspace JSON backup/restore and per-conversation Markdown export.
- Responsive mobile layout, installable PWA output, and Electron desktop packaging.

## Security And Data

OpenAI Studio is a direct client, not a local-only inference application:

- Prompts, attachments, and instructions are sent to OpenAI. Generated responses are returned by OpenAI and retained server-side when response storage is enabled.
- Responses API requests use `store: true` so conversations can continue with `previous_response_id`. New-chat title generation also creates a stored API response.
- The API key entered in Settings is stored locally in `settings.json` and is not encrypted by this project.
- A full workspace export includes any API key saved in Settings, conversations, system instructions, and attachment data. Treat exported JSON files as secrets.
- Browser storage is scoped to the origin. Clearing site data, removing the desktop app's user data, or changing origins can make the workspace unavailable.

Do not put a shared or production API key into a publicly deployed build. Each user should enter their own key in Settings.

## Prerequisites

- Node.js 20.3 or newer and npm. The locked toolchain also supports Node 18.17+, but a current supported LTS is recommended.
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

### Optional Local Environment Key

For local development or Electron development, an ignored `.env.local` file can provide a convenience key:

```dotenv
OPENAI_API_KEY=sk-...
```

Development and Electron modes compile this value into renderer JavaScript. Do not use this mechanism for a build that will be packaged, published, or shared. Production web mode intentionally excludes `OPENAI_API_KEY`; users must enter it in the UI. An environment-only key can authorize model calls, but generated-file download controls require the key to be entered in Settings.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the exact dependency versions from `package-lock.json`. |
| `npm run dev` | Start the web dev server at `/openai-studio/`. |
| `npm run electron:dev` | Start Vite in Electron mode and launch Electron against it on port 5173. |
| `npm run build` | Typecheck and create an Electron-mode bundle in `dist/`. |
| `npm run build:electron` | Explicit alias for the Electron-mode build. |
| `npm run build:web` | Typecheck and create the web/PWA bundle in `dist/`. |
| `npm run preview` | Serve the existing `dist/` directory; run `build:web` first for PWA verification. |
| `npm run dist` | Build and package the configured Electron target into `release/`. |
| `npm run deploy` | Build the web app and publish `dist/` with `gh-pages`. |
| `node scripts/generate-icons.js` | Regenerate the PNG application icons. |

There is currently no automated test, lint, or format script.

## Web And PWA

Create and preview a production PWA build:

```bash
npm run build:web
npm run preview
```

Open `http://localhost:4173/openai-studio/`. The preview command serves the current contents of `dist/`; it does not rebuild after source changes.

The web base path is configured in `vite.config.ts` as `/openai-studio/`, matching this repository's GitHub Pages path. The generated PWA `scope` and `start_url` derive from `base`. When deploying under another repository path or at a domain root, change `base` and also align or remove the separate root `manifest.json` linked by `index.html`.

Deploy the PWA over HTTPS. Localhost is treated as a secure context for development and preview, but service workers are not available from an ordinary HTTP production origin.

Deploy the current web build to the configured `gh-pages` destination with:

```bash
npm run deploy
```

The service worker caches the application shell and selected assets. OpenAI requests still require a network connection, so installation does not make model features available offline. Tailwind is loaded from `cdn.tailwindcss.com` and is not covered by the current runtime cache, so uncached styling also requires connectivity.

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

The logical files are:

- `sessions.json`: conversations, attachments, response metadata, and per-chat configuration.
- `settings.json`: theme, API key, and last active session.
- `system_instructions.json`: reusable instruction records.

Writes are debounced and each changed file keeps one previous `<filename>.bak` copy. If a primary file contains malformed JSON, the storage layer attempts to read its backup. These are browser-managed files rather than ordinary project files; use Settings -> Export for a portable backup.

Import asks for confirmation and replaces the supplied workspace sections. The chat header's Share button does not publish a link; it downloads a local Markdown file containing message text. That file omits response details, sources, generated-file references, and attachment data, using a placeholder only for attachment-only messages. Generated container files can expire, so download files that need to be retained.

Chat deletion is immediate and has no in-app undo. Export the workspace before destructive cleanup.

## Architecture

```text
index.tsx
  -> App.tsx                 application state, persistence, request lifecycle
      -> components/         chat, sidebar, configuration, Electron title bar
      -> services/
          storage.ts         OPFS/IndexedDB persistence and workspace backup
          openaiService.ts   Responses API requests, streaming, tools, citations
      -> utils/              conversation export and source URL handling

electron/                    Electron main and preload processes
types.ts                     application types and OpenAI SDK-backed aliases
constants.ts                 model metadata and configuration normalization
vite.config.ts               web/Electron asset modes and generated PWA config
public/                      static icons
scripts/                     maintenance utilities
```

`App.tsx` owns the application state and passes it to functional React components. `services/openaiService.ts` threads compatible turns with `previous_response_id`, streams text deltas into placeholders, and parses the completed response for citations, usage, Code Interpreter output, and generated files.

## Development Verification

Before submitting a change, run the mode-specific builds it affects. For shared TypeScript or React changes, run both:

```bash
npm run build
npm run build:web
```

Smoke-test the web UI at desktop and mobile widths. Changes to Electron, persistence, PWA behavior, streaming, cancellation, attachments, or import/export should also be exercised in the corresponding runtime.
