'use strict';

// Runs in the page MAIN world at document_start, before any game scripts.
// Monkey-patches WebSocket and fetch to capture SmashKarts network traffic.
// Captured entries are forwarded to the isolated content script via postMessage.

(function () {
  const OWN_SERVER = 'localhost:8080';

  function capture(entry) {
    window.postMessage({ __sk_cap: true, ...entry }, '*');
  }

  function describeData(data) {
    if (typeof data === 'string') {
      // Truncate very long strings so log lines stay readable
      return { text: data.length > 2000 ? data.slice(0, 2000) + '…' : data };
    }
    if (data instanceof ArrayBuffer) return { binary: true, byteLength: data.byteLength };
    if (typeof Blob !== 'undefined' && data instanceof Blob) return { binary: true, blobSize: data.size };
    return { binary: true };
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  const OrigWebSocket = window.WebSocket;

  class PatchedWebSocket extends OrigWebSocket {
    constructor(...args) {
      super(...args);
      const wsUrl = args[0] instanceof URL ? args[0].href : String(args[0]);

      // Don't capture our own chat server traffic
      if (wsUrl.includes(OWN_SERVER)) return;

      capture({ kind: 'ws_connect', url: wsUrl, at: Date.now() });

      // ── Firebase: extract in-game username from udro payload ──────────────
      if (wsUrl.includes('firebaseio.com')) {
        this.addEventListener('message', (e) => {
          if (typeof e.data !== 'string') return;
          try {
            const msg = JSON.parse(e.data);
            const path = msg?.d?.b?.p ?? '';
            const data = msg?.d?.b?.d;
            // path is like "users/<uid>/udro" — pub.userName holds the in-game name
            if (path.endsWith('udro') && data?.pub?.userName) {
              capture({ kind: 'player_name', name: data.pub.userName, at: Date.now() });
            }
          } catch { /* ignore malformed frames */ }
        });
      }

      // ── Photon /game/ WS: signals active match start / end ────────────────
      if (wsUrl.includes('exitgames.com/game/')) {
        capture({ kind: 'game_active', at: Date.now() });
        this.addEventListener('close', () => {
          capture({ kind: 'game_ended', at: Date.now() });
        });
      }

      this.addEventListener('message', (e) => {
        capture({ kind: 'ws_recv', url: wsUrl, ...describeData(e.data), at: Date.now() });
      });

      this.addEventListener('close', (e) => {
        capture({ kind: 'ws_close', url: wsUrl, code: e.code, reason: e.reason, at: Date.now() });
      });

      // Override send on the instance so we see outgoing frames
      const origSend = this.send.bind(this);
      this.send = (data) => {
        capture({ kind: 'ws_send', url: wsUrl, ...describeData(data), at: Date.now() });
        origSend(data);
      };
    }
  }

  // Keep the name tidy in dev-tools
  Object.defineProperty(PatchedWebSocket, 'name', { value: 'WebSocket' });
  window.WebSocket = PatchedWebSocket;

  // ── fetch ──────────────────────────────────────────────────────────────────

  const origFetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(OWN_SERVER)) return origFetch.call(this, input, init);

    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    capture({ kind: 'fetch_req', url, method, at: Date.now() });

    try {
      const resp = await origFetch.call(this, input, init);
      capture({ kind: 'fetch_res', url, status: resp.status, at: Date.now() });
      return resp;
    } catch (err) {
      capture({ kind: 'fetch_err', url, error: String(err), at: Date.now() });
      throw err;
    }
  };
})();
