# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Running the app

First-time setup (once):

```
npm install
npm run setup:backend
```

Then:

```
npm run build
npm run dev:electron
```

Electron automatically starts the Python backend on launch (waiting for it to
become healthy before showing the window) and stops it when the app quits —
you no longer need to run the backend manually in a separate terminal.

`npm run setup:backend` creates a `.venv` at the project root and installs
`requirements.txt` into it. Re-run it any time `requirements.txt` changes.

For debugging the backend in isolation, you can still run it manually with:

```
cd backend && python -m app.server
```

This runs the `if __name__ == "__main__":` guard in `backend/app/server.py`, which calls `main()` and binds the server to `127.0.0.1` only (port `8000` by default, override with the `PORT` env var). Prefer this over hand-typing `uvicorn app.server:app --reload --port 8000`, since that command does not enforce the localhost-only bind.

## Building an installer (Windows)

```
npm install
npm run setup:backend
npm run dist
```

This produces a Windows installer under `release/`. The installer bundles the Python backend (frozen with PyInstaller) and ffmpeg/ffprobe, so **end users installing the packaged app do not need Python or ffmpeg installed separately.**

The one remaining external dependency for end users is [Ollama](https://ollama.com) — install it and pull a chat model before using the chat/summarize features.

`npm run setup:backend` and the `.venv` it creates are only needed for *building* the installer (or running the backend directly in dev mode) — they are not needed by someone just installing and running the packaged app.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is enabled on this template. See [this documentation](https://react.dev/learn/react-compiler) for more information.

Note: This will impact Vite dev & build performances.

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
