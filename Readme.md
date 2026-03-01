# SmashKarts Chat - Production Deployment

This repo ships two deliverables:
- `server/`: Rust/Axum WebSocket backend (`/ws`, `/health`, `/metrics`, `/log`)
- `extension/`: Chrome MV3 extension

## 1. Deploy the server

### Environment variables
Use `/Users/prakharojha/Desktop/me/personal/smash-karts-chat/server/.env.example` as reference:
- `GOOGLE_CLIENT_ID` (required)
- `BIND_ADDR` (default `0.0.0.0:8080` in container)
- `LOG_PATH` (default `game-traffic.log`, set to a mounted volume path for persistence)
- `RUST_LOG` (optional)

### Docker (local smoke check)
```bash
cd /Users/prakharojha/Desktop/me/personal/smash-karts-chat/server
docker build -t smash-karts-chat-server .
docker run --rm -p 8080:8080 \
  -e GOOGLE_CLIENT_ID=<your-client-id> \
  -e BIND_ADDR=0.0.0.0:8080 \
  -e LOG_PATH=/app/game-traffic.log \
  smash-karts-chat-server
```

### Railway deployment (recommended first launch)
1. Push this repo to GitHub.
2. In Railway, deploy using `/server` as service root.
3. Set env vars: `GOOGLE_CLIENT_ID`, `BIND_ADDR=0.0.0.0:8080`, optional `LOG_PATH=/data/game-traffic.log` if volume mounted.
4. Confirm endpoints:
```bash
curl https://<your-domain>/health
curl https://<your-domain>/metrics
```

## 2. Build production extension zip

Use the packaging script to inject release config and create a clean zip artifact.

```bash
cd /Users/prakharojha/Desktop/me/personal/smash-karts-chat
node scripts/package-extension.mjs \
  --server-url https://<your-domain> \
  --oauth-client-id <your-google-oauth-client-id>
```

Output:
- `dist/smash-karts-chat-extension.zip` (upload this to Chrome Web Store)
- `dist/extension-release/` (fully rendered extension files used in the zip)

What the script patches in release output:
- `background.js`: `WS_BASE` and `LOG_URL`
- `manifest.json`: `oauth2.client_id` and `host_permissions` for your server domain

## 3. Pre-distribution checklist

- [ ] Server is live over `wss://` and `/health` + `/metrics` return success
- [ ] `GOOGLE_CLIENT_ID` matches extension OAuth client
- [ ] Extension artifact built from `scripts/package-extension.mjs`
- [ ] Add extension icon(s) and store screenshots before Chrome Web Store submission
- [ ] Publish privacy policy URL for listing requirements

## 4. Load test quick run

```bash
cd /Users/prakharojha/Desktop/me/personal/smash-karts-chat/load-test
npm run light
```
