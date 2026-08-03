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
- Local projects with names, icons, live project instructions, per-project chat defaults, grouped chats, and reusable source libraries.
- Automatic project File Search, Code Interpreter data sources, explicit attach-when-needed files, file citations, indexed-usage visibility, and durable remote cleanup.
- Configured model picker for GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5, GPT-5 Nano, and o3. Model availability depends on the API account.
- Model-specific reasoning effort and text verbosity controls.
- Automatic model identity and knowledge-cutoff preambles, followed by any reusable system instruction selected by the user and applied through the Responses API `instructions` field.
- Optional Web Search and Code Interpreter tools, with per-chat Web Search
  context size and approximate location controls (default: Medium and New York,
  NY, US).
- Multiple image and file attachments, including files pasted from the clipboard.
- GitHub Flavored Markdown, code blocks, tables, citations, generated Code Interpreter files, and response copying.
- Assistant progress commentary is shown in a collapsible section while final-answer output remains the primary response.
- Per-response model, reasoning effort, time-to-first-token, and token-usage details. Model names are captured with each answer, so later catalog changes do not relabel conversation history.
- Global project/chat search with membership paths, plus light and dark themes.
- Checksummed ZIP workspace backup/merge/restore, opt-in daily folder backups, action-aware merge/restore undo, and per-conversation Markdown export.
- Responsive mobile layout, installable PWA output, and Electron desktop packaging.

## Security And Data

OpenAI Studio is a direct client, not a local-only inference application:

- Prompts, attachments, and instructions are sent to OpenAI. Generated responses are returned by OpenAI and retained server-side when response storage is enabled.
- Adding a searchable or analysis project source uploads it to OpenAI immediately after its canonical local bytes are saved. OpenAI Files and vector stores persist until deleted; deleting a local source or project starts remote deletion and records failed cleanup for retry.
- Responses API requests use `store: true` so conversations can continue with `previous_response_id`. New-chat title generation also creates a stored API response.
- The API key entered in Settings is stored in the local workspace settings object and is not encrypted by this project.
- A portable ZIP includes conversations, projects, project instructions, original project-source bytes, system instructions, attachments, and locally cached generated files, but never the API key, OpenAI File/vector-store IDs, key fingerprints, cleanup records, or device-local backup preferences. Restoring keeps the current device's key. Archives are not encrypted and can contain sensitive content.
- OpenAI documents Files and vector stores as retained until deleted, with abuse-monitoring and post-deletion behavior governed by its current [API data-retention policy](https://developers.openai.com/api/docs/guides/your-data#storage-requirements-and-retention-controls-per-endpoint).
- Browser storage is scoped to the origin. Clearing site data, removing the desktop app's user data, or changing origins can make the workspace unavailable.

Do not put a shared or production API key into a publicly deployed build. Each user should enter their own key in Settings.

## Prerequisites

- Node.js 22.12 or newer and npm.
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

Development and Electron modes compile this value into renderer JavaScript. It
is used for normal chats and project-source upload, indexing, reconciliation,
and cleanup whenever Settings does not contain a key. Do not use this mechanism
for a build that will be packaged, published, or shared. Production web mode
intentionally excludes `OPENAI_API_KEY`; users must enter it in the UI.
Generated files are cached locally after a response when possible; cached
copies remain downloadable without a key, while an uncached download requires
either the Settings key or the compiled local key.

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

## Projects And Sources

Use **New Project** in the sidebar to create a recurring-work container. A
project owns its instructions, default model/reasoning/verbosity/tool settings,
chats, and source library. Defaults are copied only into newly created project
chats. Project instructions are resolved live for every future request; changing
them does not rewrite earlier messages. Create project chats from the project
home; existing chats cannot be moved between projects or into the standalone
**Chats** section.

Each project supports at most 40 sources, with at most 10 files selected per
upload and the existing strict per-file limit of less than 50 MiB. Source bytes
are saved and verified locally first, then routed as follows:

- **Searchable** formats are uploaded to a lazily created, project-exclusive
  OpenAI vector store and become automatic File Search context.
- **Analysis** data files are uploaded as OpenAI Files and supplied to Code
  Interpreter when that chat tool is enabled.
- **Attach when needed** files remain in the local project library and are added
  to a message only when selected in the composer; they are not silently
  injected.

If expected automatic sources are unavailable, sending is blocked unless the
user explicitly confirms a one-request send without project sources. Project
instructions still apply. Upload/index work is sequential, the app uses OpenAI's
reported vector-store `usage_bytes`, and app-managed indexed storage is capped
at 900 MiB. If indexing crosses the cap, the new OpenAI File is deleted and the
source is rejected.

File Search is not necessarily free. As of this documentation update, OpenAI's
[live pricing page](https://developers.openai.com/api/docs/pricing#built-in-tools)
lists 1 GiB of vector-store storage free across the account, then $0.10/GiB/day,
plus $2.50 per 1,000 Responses API File Search calls; retrieved tokens are billed
at the selected model's rates. The account-wide free allowance may already be
used by vector stores outside this app, and parsed chunks plus embeddings can be
larger than the source files.

Deleting a source removes it from future requests immediately and deletes its
underlying OpenAI File, which also removes it from any vector store containing
it. Deleting a project permanently deletes the project, all member chats,
instructions, and sources, with no in-app undo. Deleted member chats do not
return to the standalone **Chats** section. OpenAI Files are deleted before the
vector store. Failed cleanup
remains visible in Settings for retry. External ZIP backups are separate files
and are not erased by local project deletion.

API-key editing is staged behind **Save API key**. If project resources exist
under the old key, the app must delete them with that key before it persists the
new one. Authentication failures block the switch and show the remote resource
IDs so they can be removed through the OpenAI dashboard. Saving again then
requires an explicit confirmation that manual cleanup is complete before the
local cleanup records are cleared.

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

- **Backup** creates an integrity-checked ZIP containing conversations, projects,
  project sources, custom instructions, attachments, and locally cached
  generated files. It excludes the API key, remote project registry, and
  device-local backup preferences.
- **Restore** validates the selected ZIP and shows a preview before replacing
  the workspace. The current device's API key is preserved.
- **Merge** starts after file selection without a separate preview or
  confirmation. It preserves current settings and chats, skips identical chats,
  and keeps conflicting archived chats as remapped copies.
- **Undo last restore** or **Undo last merge** reverses only the latest
  successful workspace mutation and is single-use.

Legacy JSON exports are deliberately unsupported. Archives are unencrypted and
can contain sensitive prompts, responses, project instructions, and original
file/source data.

Compatible Chromium browsers and Electron can opt into automatic backups by choosing a folder. Automatic backups:

- are disabled by default;
- run at the next eligible foreground opportunity, at most once per local day;
- skip unchanged persisted revisions and run only in the writer tab;
- pause for responses, generated-file caching, destructive operations, or renewed folder permission;
- verify a newly written archive before rotation and retain the three newest valid managed archives;
- never delete unrelated files in the selected folder.

Electron waits for a due backup during close and offers Retry or Close Without Backup on failure. Browsers without the File System Access directory picker, including the iOS path, retain **Backup** (Share when available, download otherwise), **Merge**, and **Restore**. Browser folder handles and scheduler history are device-local and excluded from archives.

The chat header's Share button does not publish a link; it downloads a local Markdown file containing message text, labeling assistant progress and final-answer phases when available. That file omits response details, sources, generated-file references, and attachment data, using a placeholder only for attachment-only messages. Remote generated files can expire before caching succeeds, and archives report how many generated-file references lack local bytes.

Chat deletion asks for confirmation and has no in-app undo. Project deletion is
also permanent and clears the current merge/restore undo point. Export the
workspace before destructive cleanup, while remembering that exported ZIPs are
not deleted automatically later.

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
