
# OpenAI Studio

OpenAI Studio is a sophisticated web-based chat interface designed to mimic the capabilities of professional AI development environments like Google AI Studio, but tailored for OpenAI's models (specifically targeting the next-gen GPT-5 series and reasoning models like o3).

It provides a rich, persistent workspace for developers and power users to interact with LLMs, offering granular control over model parameters, system instructions, and tool usage.

It uses OpenAI new Responses API: https://platform.openai.com/docs/api-reference/responses

## Features

*   **Professional Interface:** A clean, dark-mode ready UI built with Tailwind CSS.
*   **Automatic Persistence:** The app automatically creates a secure `data/` folder in your browser's private storage (OPFS).
    *   **No Setup:** Just open the app and start chatting. Your history is saved instantly.
    *   **Privacy:** Data is stored locally in your browser's sandboxed file system.
*   **Advanced Configuration:**
    *   **Model Selection:** Switch between ChatGPT o3, GPT-5.2 (Flagship), Mini, and Nano models.
    *   **Reasoning Effort:** Adjust the depth of the model's thinking process (Low/Medium/High for o3; None to XHigh for GPT-5).
    *   **Text Verbosity:** Control the length and detail of generated responses (GPT-5 series only).
*   **System Instructions:** Create and manage a library of system prompts to steer model behavior.
*   **Tool Integration:** Toggle Web Search and Code Interpreter capabilities.
*   **Artifacts & Citations:** Rich rendering of Markdown, code blocks, and source citations.

## Setup & Usage

### Prerequisites

*   An OpenAI API Key.
*   A modern web browser (Chrome, Edge, Opera, Safari 15.2+) that supports **Origin Private File System**.

### Running the Application (Web)

This project is built as a client-side React application.

**Option 1: Development Environment (Recommended)**
If you are moving this code to a local machine, the recommended setup is using [Vite](https://vitejs.dev/):

1.  Initialize a new Vite project: `npm create vite@latest openai-studio -- --template react-ts`
2.  Copy the source files into the `src` directory (adjusting `index.html` location as needed).
3.  Install dependencies: `react`, `react-dom`, `lucide-react`, `react-markdown`, `openai`, `uuid`.
4.  Run `npm run dev`.

**Option 2: Static / Sandbox**
The project is currently structured to run in environments that support direct `.tsx` loading.

### Running as a Desktop App (Electron)

You can turn this web application into a standalone desktop application for Windows, macOS, or Linux.

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Run in Development Mode:**
    To run the desktop app alongside the Vite dev server:
    ```bash
    npm run electron:dev
    ```

3.  **Build for Production:**
    To generate the executable file (installer):
    ```bash
    npm run dist
    ```
    Once the build finishes, check the newly created **`release`** folder in your project directory to find the installer (e.g., `.exe`, `.dmg`, or `.AppImage`).

## Data Structure & Location

The application uses the **Origin Private File System (OPFS)**. While the app internally reads and writes to `sessions.json`, these are stored in a sandboxed, virtual file system managed by the operating system's web engine.

**Important:** You generally cannot access these files directly via your File Explorer as plain JSON. To backup or transfer your data, use the **Export/Import** buttons in the application Settings.

### Desktop App (Physical Location)
The raw, obfuscated data container is stored in the standard AppData directories:

*   **Windows:** `%APPDATA%\OpenAI Studio`
    *   *Path:* `C:\Users\<YourUser>\AppData\Roaming\OpenAI Studio`
*   **macOS:** `~/Library/Application Support/OpenAI Studio`
*   **Linux:** `~/.config/OpenAI Studio` (or `$XDG_CONFIG_HOME/openai-studio`)

### Logical Structure (Internal)
Inside the app, the data is organized as follows:

### Configuration

1.  Launch the application.
2.  **API Key:** Click the user profile area in the bottom-left corner of the sidebar and enter your OpenAI API Key. The key is saved locally to `settings.json`.

## Data Structure

The application automatically manages these files in the browser's private file system:

*   `data/sessions.json`: Contains your complete chat history.
*   `data/settings.json`: Stores your API Key, theme preference, and last active session.
*   `data/system_instructions.json`: Stores your library of system prompts.

## Project Structure

*   **`App.tsx`**: The main application controller. Handles storage initialization and auto-saving.
*   **`services/storage.ts`**: Manages the Origin Private File System (OPFS) connection.
*   **`services/openaiService.ts`**: The API layer.
*   **`components/`**: UI components (Sidebar, ChatArea, ConfigPanel).

## License

MIT
