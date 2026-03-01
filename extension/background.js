'use strict';

const WS_BASE = 'ws://localhost:8080/ws';
const MAX_RECONNECT_DELAY = 30_000;
// Client-side guard: service worker won't forward faster than this.
// Server enforces its own 500 ms hard limit regardless.
const CLIENT_RATE_LIMIT_MS = 600;

let ws = null;
let currentTabId = null;
let currentMode = null;
let reconnectDelay = 1_000;
let reconnectTimer = null;
let lastSentAt = 0;
let detectedPlayName = null; // player name detected from game DOM
let connectToken = 0; // incremented on each connect() call to cancel in-flight duplicates

// ---- Play profile (anonymous fallback) ----

async function getPlayProfile() {
  const stored = await chrome.storage.local.get(['playId', 'playName']);
  const playId = stored.playId ?? crypto.randomUUID();
  // Prefer name detected from game DOM, then stored name, then fallback
  const playName = detectedPlayName ?? stored.playName ?? 'Player';
  if (!stored.playId) await chrome.storage.local.set({ playId });
  return { playId, playName };
}

// ---- Auth + URL construction ----

async function buildWsUrl(mode) {
  // Try Google OAuth (non-interactive first so we don't pop a dialog mid-game)
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(token);
        }
      });
    });
    const url = new URL(WS_BASE);
    url.searchParams.set('mode', mode);
    url.searchParams.set('provider', 'google_access_token');
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    // Fall back to anonymous play profile
    const { playId, playName } = await getPlayProfile();
    const url = new URL(WS_BASE);
    url.searchParams.set('mode', mode);
    url.searchParams.set('provider', 'play');
    url.searchParams.set('play_id', playId);
    url.searchParams.set('play_name', encodeURIComponent(playName));
    return url.toString();
  }
}

// ---- Reconnection ----

function clearReconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnect();
  reconnectTimer = setTimeout(
    () => connect(currentMode, currentTabId),
    reconnectDelay,
  );
  // Exponential backoff with jitter, capped at MAX_RECONNECT_DELAY
  reconnectDelay = Math.min(
    reconnectDelay * 2 + Math.random() * 500,
    MAX_RECONNECT_DELAY,
  );
}

// ---- Tab messaging ----

function sendToTab(msg) {
  if (currentTabId == null) return;
  chrome.tabs.sendMessage(currentTabId, msg).catch(() => {
    // Tab may have closed; stop reconnecting to it
  });
}

// ---- WebSocket lifecycle ----

async function connect(mode, tabId) {
  clearReconnect();
  if (!mode) return;

  currentMode = mode;
  currentTabId = tabId ?? currentTabId;

  if (ws) {
    ws.close(1000);
    ws = null;
  }

  // Claim a token before the async gap. If another connect() call arrives
  // while we're awaiting buildWsUrl, it increments connectToken and our
  // continuation will bail — preventing a second orphaned WebSocket in the room.
  const myToken = ++connectToken;

  let wsUrl;
  try {
    wsUrl = await buildWsUrl(mode);
  } catch (e) {
    if (myToken !== connectToken) return;
    sendToTab({ type: 'status', connected: false, error: 'Auth failed' });
    scheduleReconnect();
    return;
  }

  if (myToken !== connectToken) return;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    reconnectDelay = 1_000; // reset backoff on successful connect
    sendToTab({ type: 'status', connected: true, room: mode });
  };

  ws.onmessage = (e) => {
    try {
      sendToTab(JSON.parse(e.data));
    } catch {
      // Ignore malformed frames
    }
  };

  ws.onclose = (e) => {
    ws = null;
    sendToTab({ type: 'status', connected: false });
    // 1000 = normal close (we requested it); anything else → reconnect
    if (e.code !== 1000 && currentMode) {
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    // onclose fires after onerror; let it handle reconnect
  };
}

function disconnect() {
  clearReconnect();
  currentMode = null;
  if (ws) {
    ws.close(1000);
    ws = null;
  }
}

function sendChat(text) {
  const now = Date.now();
  if (now - lastSentAt < CLIENT_RATE_LIMIT_MS) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  lastSentAt = now;
  ws.send(JSON.stringify({ type: 'chat', text }));
}

// ---- Game traffic logging ----

const LOG_URL = 'http://localhost:8080/log';

function logTraffic(entry) {
  fetch(LOG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  }).catch(() => {
    // Server may not be running; silently drop.
  });
}

// ---- Message handler from content script ----

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id ?? currentTabId;
  switch (msg.type) {
    case 'connect':
      // Skip if already connected (or connecting) to the same room
      if (msg.mode === currentMode && ws && ws.readyState <= WebSocket.OPEN) break;
      if (msg.playName) detectedPlayName = msg.playName;
      connect(msg.mode, tabId);
      break;
    case 'chat':
      sendChat(msg.text);
      break;
    case 'disconnect':
      disconnect();
      break;
    case 'auth_interactive':
      // Content script can trigger an interactive sign-in prompt
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (token && currentMode) connect(currentMode, tabId);
      });
      break;
    case 'game_traffic':
      if (msg.entry) logTraffic(msg.entry);
      break;
  }
});
