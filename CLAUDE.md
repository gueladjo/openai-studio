# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenAI Studio is a React + TypeScript desktop/web chat interface for OpenAI's models (GPT-5 series and o3). It uses OpenAI's Responses API and stores data client-side via the browser's Origin Private File System (OPFS).

## Commands

```bash
npm run dev           # Start Vite dev server (port 5173)
npm run build         # TypeScript check + Vite production build → dist/
npm run electron:dev  # Run Vite + Electron together (recommended for development)
npm run dist          # Build and package as installer → release/
```

## Architecture

**State Management**: Centralized in `App.tsx` using React `useState` hooks. No Redux/Context - state flows via props drilling to child components.

**Data Flow**:
```
User Input (ChatArea) → App.tsx (state) → openaiService.ts (API) → OpenAI Responses API
                                       ↓
                           storage.ts (OPFS) ← Parse response ← Update state
```

**Persistence**: Debounced writes (1s for sessions, 500ms for settings) to three JSON files in OPFS:
- `data/sessions.json` - Chat conversations
- `data/settings.json` - Theme, API key, last session
- `data/system_instructions.json` - System prompt library

**Key Services**:
- `services/openaiService.ts`: API integration with Responses API, handles multimodal input (text + base64 images), reasoning effort config, tool options (web_search, code_interpreter)
- `services/storage.ts`: OPFS file operations, backup/restore

**Components**:
- `App.tsx`: Master controller, all state management, OPFS I/O
- `components/ChatArea.tsx`: Message list, input, file attachments, markdown rendering
- `components/Sidebar.tsx`: Session list, theme toggle, API key modal, export/import
- `components/ConfigPanel.tsx`: Model selector, reasoning effort slider, tools toggles, system instructions
- `components/TitleBar.tsx`: Electron-only custom window controls

## Key Types (types.ts)

```typescript
enum ModelId { GPT_5_2, GPT_5_MINI, GPT_5_NANO, GPT_O3 }

interface ChatConfig {
  model: ModelId;
  reasoningEffort: string;  // Model-dependent (none/low/medium/high/xhigh)
  textVerbosity: 'low' | 'medium' | 'high';
  tools: { webSearch: boolean; codeInterpreter: boolean; };
  systemInstructionId?: string;
}

interface Session { id, title, messages: Message[], config: ChatConfig, lastModified }
interface Message { role, content, thinking?, sources?, attachments?, timestamp }
```

## Styling

- Tailwind CSS via CDN (inline classes, no separate CSS files except `index.css` for globals)
- Dark mode: `.dark` class on root, `dark:` prefix for variants
- Fonts: Inter (sans), JetBrains Mono (code)
