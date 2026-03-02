# SmashKarts Chat

Real-time, mode-based chat for SmashKarts, built as:
- A Rust + Axum WebSocket backend
- A Chrome MV3 extension chat overlay

## What this does

- Detects the active SmashKarts mode in the browser
- Connects players in the same mode to the same chat room
- Sends and receives chat in real time over WebSocket
- Supports optional Google auth with automatic anonymous fallback (`play` mode)
- Exposes backend health and metrics endpoints

## Repository structure

- `server/` Rust backend (`/ws`, `/health`, `/metrics`, `/log`)
- `extension/` Chrome extension source
- `load-test/` Node.js load test scripts
- `scripts/package-extension.mjs` production extension packaging script
- `plans/` planning and rollout docs

## Architecture (high level)

1. Extension content scripts run on `https://smashkarts.io/*`
2. Extension background worker opens WebSocket to backend `/ws`
3. Backend authenticates user (`google_access_token` or `play`)
4. Backend routes messages by normalized room (`mode`)
5. Messages are broadcast to subscribers in the same room

## Local development

### Prerequisites

- Rust stable toolchain
- Node.js 18+
- Google OAuth client ID (if testing Google auth)

### 1) Run backend

```bash
cd /Users/prakharojha/Desktop/me/personal/smash-karts-chat/server
GOOGLE_CLIENT_ID=local-dev-placeholder BIND_ADDR=127.0.0.1:8080 cargo run
```

Notes:
- `GOOGLE_CLIENT_ID` is required at startup.
- Anonymous fallback chat (`provider=play`) still works even if Google auth is not configured.

### 2) Load extension unpacked

1. Open Chrome: `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked"
4. Select `/Users/prakharojha/Desktop/me/personal/smash-karts-chat/extension`

Current source defaults:
- `WS_BASE=ws://localhost:8080/ws`
- `LOG_URL=http://localhost:8080/log`

### 3) Smoke test

- Open SmashKarts in one or two tabs/profiles
- Verify extension connects and chat messages appear
- Backend checks:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/metrics
```

## Production deployment

### Railway (recommended)

Service configuration:
- Root directory: `/server`
- Healthcheck path: `/health`
- Optional watch path: `/server/**`

Environment variables:
- `GOOGLE_CLIENT_ID=<your chrome oauth client id>`
- `BIND_ADDR=0.0.0.0:8080`
- `LOG_PATH=game-traffic.log` (or mounted volume path)
- `RUST_LOG=info` (optional)

Once deployed, verify:

```bash
curl https://<your-domain>/health
curl https://<your-domain>/metrics
```

## Build production extension artifact

Use the packager to inject production URL + OAuth client ID into a clean release output:

```bash
cd /Users/prakharojha/Desktop/me/personal/smash-karts-chat
node scripts/package-extension.mjs \
  --server-url https://<your-domain> \
  --oauth-client-id <your-google-oauth-client-id>
```

Generated artifacts:
- `dist/smash-karts-chat-extension.zip` (upload to Chrome Web Store)
- `dist/extension-release/` (rendered extension files)

## Chrome Web Store submission checklist

- [ ] Backend live on `wss://` domain
- [ ] Extension zip built from `scripts/package-extension.mjs`
- [ ] Correct OAuth client ID in packaged manifest
- [ ] Store icon, screenshots, and listing text ready
- [ ] Privacy policy URL set (see `privacy-policy.md`)

## Load testing

```bash
cd /Users/prakharojha/Desktop/me/personal/smash-karts-chat/load-test
npm install
npm run light
npm run medium
```

## Key endpoints

- `GET /health` liveness check
- `GET /metrics` runtime counters
- `GET /ws?mode=<mode>&provider=<...>` websocket endpoint
- `POST /log` game traffic logging endpoint

## Troubleshooting

### Healthcheck fails after deploy

- Confirm `GOOGLE_CLIENT_ID` is set in Railway
- Confirm `BIND_ADDR=0.0.0.0:8080`
- Check startup logs for first runtime error

### Extension connects locally instead of production

- You loaded `/extension` (source). For production-configured testing, load `/dist/extension-release`.

### Google sign-in fails

- OAuth client must match the extension ID (especially for Web Store build)
- Chat can still work via anonymous fallback mode

## Security and privacy

- Permission usage and user-data handling are documented in `privacy-policy.md`
- Extension requests only: `identity`, `storage`, required host permissions

## License

Add your preferred license in this repository (e.g., MIT) before broad distribution.
