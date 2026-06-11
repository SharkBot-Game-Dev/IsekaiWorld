# React + TypeScript + Vite

## Isekai World

Run the WebSocket world server and Vite client in separate terminals:

```sh
npm run server
npm run dev
```

By default, the client connects to `ws://127.0.0.1:8787/world`. To use another world server, set `VITE_WORLD_WS_URL` before starting Vite.

The client renders a 3D world with terrain height, props, server-defined items, and a follow camera. Player save data and recent chat are stored in SQLite at `server/data/world.sqlite`.

Server-side WebSocket event handlers live in `server/events`. Server-owned image assets live in `server/assets` and are served from `http://127.0.0.1:8787/assets/<file>`. The asset manifest is available at `http://127.0.0.1:8787/assets`.

Server-defined item settings live in `server/items` as JSON files and are served from `http://127.0.0.1:8787/items`. Items are included in the WebSocket `welcome` payload and rendered in the client world.

```json
{
  "id": "crystal",
  "name": "Blue Crystal",
  "kind": "resource",
  "color": "#38bdf8",
  "asset": "player-token.svg",
  "position": { "x": -7, "z": 5 },
  "scale": 1.15
}
```

To federate world servers, start each server with a stable `WORLD_SERVER_ID` and point `WORLD_PEERS` at the other server's `/peer` endpoint:

```sh
WORLD_PORT=8787 WORLD_SERVER_ID=alpha WORLD_PEERS=ws://127.0.0.1:8788/peer npm run server
WORLD_PORT=8788 WORLD_SERVER_ID=beta WORLD_PEERS=ws://127.0.0.1:8787/peer npm run server
```

Clients can connect to any server by editing the World Server field in the app. Peer-linked servers relay chat messages across the federation.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

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
