# Repository Guidelines

## Project Structure & Module Organization
- Root entry points: `index.tsx` (bootstraps React) and `App.tsx` (top-level state/controller).
- UI lives in `components/` (e.g., `ChatArea.tsx`, `Sidebar.tsx`, `ConfigPanel.tsx`, `TitleBar.tsx`).
- Integrations and persistence live in `services/` (OpenAI Responses API + OPFS storage).
- Desktop packaging is in `electron/` (main/preload process files).
- Static assets and PWA metadata are in `public/`, `manifest.json`, and `metadata.json`.
- Shared types/config live in `types.ts` and `constants.ts`.
- Utility scripts live in `scripts/` (e.g., `scripts/generate-icons.js`).

## Build, Test, and Development Commands
- `npm run dev` — start the Vite dev server (web).
- `npm run electron:dev` — run Vite + Electron together for desktop development.
- `npm run build` — typecheck and build for Electron output.
- `npm run build:web` — typecheck and build the web/PWA bundle.
- `npm run preview` — serve the production build locally for verification.
- `npm run dist` — package the Electron installer into `release/`.
- `npm run deploy` — build web output and publish `dist/` to GitHub Pages.

## Coding Style & Naming Conventions
- TypeScript + React functional components with hooks.
- Indentation is 2 spaces; semicolons are used; imports/strings use single quotes (follow existing style).
- Tailwind utility classes are used inline; `index.css` is reserved for global styles.
- File naming: PascalCase for components (`ChatArea.tsx`), camelCase for utilities.

## Testing Guidelines
- No automated test framework is configured yet.
- Before PRs, run `npm run build` and smoke test via `npm run dev` (web) and/or `npm run electron:dev` (desktop).
- If adding tests, prefer `*.test.tsx` or `*.spec.tsx` and document the runner in this guide.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and descriptive (e.g., `fix PWA URL.`, `Implement PWA option for Mobile.`).
- PRs should include a concise summary, testing notes, and screenshots/GIFs for UI changes. Link related issues when relevant.

## Security & Configuration Tips
- API keys are entered in-app and stored locally; never commit secrets or real user data.
- For PWA deploys, update the base path in `vite.config.ts` to match the hosting target.
