# Privacy Policy for SmashKarts Room Chat

Effective date: March 2, 2026

SmashKarts Room Chat ("the extension") provides real-time, room-based chat for players on `https://smashkarts.io`.

## 1. What data we process

The extension may process the following data to provide chat functionality:

- Account/profile data (optional Google sign-in): Google account subject ID, display name, and profile picture.
- Authentication data (optional Google sign-in): OAuth access token used to authenticate with the chat backend.
- Chat content: messages sent and received in chat rooms.
- Local profile/session data: locally stored fallback player ID and player name for anonymous mode.
- Operational logs: game/chat event records sent to the backend log endpoint.

## 2. Why we process data

Data is processed only to operate the extension's single purpose: mode-based real-time chat for SmashKarts players.

Specifically:

- To authenticate users (Google mode) or assign anonymous identity (fallback mode).
- To route users into chat rooms and deliver messages.
- To keep basic local session continuity (stored play ID/name).
- To monitor service health and diagnose issues.

## 3. Chrome permissions usage

- `identity`: used for optional Google OAuth sign-in.
- `storage`: used to store local fallback player ID/name and session-related values.
- Host permissions:
  - `https://smashkarts.io/*`: required to run the extension on the game site.
  - `https://www.googleapis.com/*`: required for optional Google profile lookup.
  - `https://smash-karts-chat-production.up.railway.app/*`: required for backend HTTP requests.
  - `wss://smash-karts-chat-production.up.railway.app/*`: required for real-time WebSocket chat.

## 4. Data sharing and sale

- We do not sell personal data.
- We do not transfer user data to third parties except as necessary to operate the service (for example, Google APIs for optional sign-in and the chat backend infrastructure).
- We do not use data for advertising, credit scoring, lending, or unrelated profiling.

## 5. Data retention

- Chat and log data may be retained on backend infrastructure for operations, moderation, and debugging.
- Retention periods may vary based on infrastructure limits and operational needs.

## 6. Security

We use HTTPS/WSS transport to protect data in transit between the extension and backend services. No security method is guaranteed to be perfect, but we take reasonable steps to protect data.

## 7. Children's privacy

The extension is not intentionally designed to collect personal information from children under applicable legal age thresholds. If you believe data was submitted in error, contact us to request deletion.

## 8. Your choices

- You may use the extension without Google sign-in via anonymous fallback mode.
- You can remove the extension at any time from Chrome.
- You can clear locally stored extension data through Chrome extension/site data controls.

## 9. Changes to this policy

We may update this policy from time to time. Material updates will be reflected by updating the effective date above.

## 10. Contact

For privacy questions or requests, contact:

- Maintainer: Prakhar Ojha
- Repository: `https://github.com/prakhar728/smash-karts-chat`

