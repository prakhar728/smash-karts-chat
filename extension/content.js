'use strict';

// Registered immediately at document_start, before any game scripts load.
// stopImmediatePropagation blocks game keyboard handlers while chat is focused.
// It does NOT prevent native character insertion in the <input> — that's a
// browser default action, unaffected by stopImmediatePropagation.
function blockIfChatFocused(e) {
  if (document.activeElement?.id === 'sk-input' && e.key !== 'Enter') {
    e.stopImmediatePropagation();
  }
}
window.addEventListener('keydown',  blockIfChatFocused, true);
window.addEventListener('keyup',    blockIfChatFocused, true);
window.addEventListener('keypress', blockIfChatFocused, true);

// ---- Constants ----

const MAX_MESSAGES = 100;
const MAX_TEXT_LENGTH = 500;

// Known SmashKarts mode strings mapped to canonical room ids.
// Order matters: more specific patterns first.
const MODE_PATTERNS = [
  { re: /team[\s-]?deathmatch/i, room: 'team-deathmatch' },
  { re: /capture[\s-]?the[\s-]?flag/i, room: 'capture-the-flag' },
  { re: /battle[\s-]?royale/i, room: 'battle-royale' },
  { re: /\bsolo\b/i, room: 'solo' },
  { re: /\blobby\b/i, room: 'lobby' },
];

// ---- State ----

let currentRoom = null;
let isConnected = false;
let inGame = false;           // true only while Photon /game/ WS is open
let firebasePlayerName = null; // in-game username extracted from Firebase
const messages = [];

// ---- Mode detection ----

function matchMode(text) {
  for (const { re, room } of MODE_PATTERNS) {
    if (re.test(text)) return room;
  }
  return null;
}

function detectMode() {
  // 1. URL ?room= param — present when joining via share link, e.g. ?room=in421800
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) return roomParam.trim().toLowerCase();

  // 2. "Share Room Name" popup in DOM: text like "Name: in421800"
  const bodyText = document.body?.textContent ?? '';
  const nameMatch = bodyText.match(/\bName:\s*([a-z0-9]{4,16})\b/i);
  if (nameMatch) return nameMatch[1].toLowerCase();

  // 3. URL path / query string for game mode keywords
  const fromUrl = matchMode(location.href);
  if (fromUrl) return fromUrl;

  // 4. DOM: elements with mode-like attributes / class names
  const candidates = document.querySelectorAll(
    '[data-mode],[data-game-mode],[class*="mode"],[class*="game-type"],[id*="mode"]',
  );
  for (const el of candidates) {
    const text = (el.dataset.mode ?? '') + ' ' + el.textContent;
    const m = matchMode(text);
    if (m) return m;
  }

  // 5. Scan any visible game UI wrapper text
  const gameRoot = document.querySelector(
    '#game, #game-ui, [class*="game-ui"], [class*="hud"]',
  );
  if (gameRoot) {
    const m = matchMode(gameRoot.textContent);
    if (m) return m;
  }

  return 'lobby';
}

// ---- DOM helpers (safe text nodes only — no innerHTML) ----

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// ---- Overlay construction ----

function buildOverlay() {
  const root = el('div', null);
  root.id = 'sk-chat-root';

  // Header
  const header = el('div', 'sk-header');
  const roomLabel = el('span', 'sk-room disconnected', 'Waiting for game…');
  roomLabel.id = 'sk-room';
  const minBtn = el('button', 'sk-icon-btn', '−');
  minBtn.id = 'sk-min';
  minBtn.title = 'Minimize';
  header.append(roomLabel, minBtn);

  // Message list
  const msgList = el('div', null);
  msgList.id = 'sk-messages';

  // Input row
  const inputRow = el('div', 'sk-input-row');
  const input = el('input', null);
  input.id = 'sk-input';
  input.type = 'text';
  input.placeholder = 'Say something…';
  input.maxLength = MAX_TEXT_LENGTH;
  input.autocomplete = 'off';
  const sendBtn = el('button', 'sk-send-btn', 'Send');
  sendBtn.id = 'sk-send';
  inputRow.append(input, sendBtn);

  // Body (messages + input)
  const body = el('div', null);
  body.id = 'sk-body';
  body.append(msgList, inputRow);

  // Footer: manual mode selector
  const footer = el('div', null);
  footer.id = 'sk-footer';
  const modeSelect = el('select', null);
  modeSelect.id = 'sk-mode-select';
  [
    ['', 'Auto-detect mode'],
    ['lobby', 'Lobby'],
    ['solo', 'Solo'],
    ['team-deathmatch', 'Team Deathmatch'],
    ['battle-royale', 'Battle Royale'],
    ['capture-the-flag', 'Capture the Flag'],
  ].forEach(([val, label]) => {
    const opt = el('option', null, label);
    opt.value = val;
    modeSelect.appendChild(opt);
  });
  footer.appendChild(modeSelect);

  // Resize handles
  const resizeHandle = el('div', 'sk-resize-handle sk-resize-se');
  const resizeHandleSW = el('div', 'sk-resize-handle sk-resize-sw');
  root.append(header, body, footer, resizeHandle, resizeHandleSW);
  document.body.appendChild(root);

  // ---- Interactions ----

  // Drag to reposition
  header.addEventListener('mousedown', (e) => {
    if (e.target === minBtn) return; // don't drag when clicking minimize
    e.preventDefault();

    // Switch from right-anchored to left-anchored so we can freely position
    const rect = root.getBoundingClientRect();
    root.style.right = '';
    root.style.left = rect.left + 'px';
    root.style.top  = rect.top  + 'px';

    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;

    root.style.cursor = 'grabbing';

    function onMove(e) {
      root.style.left = Math.max(0, e.clientX - startX) + 'px';
      root.style.top  = Math.max(0, e.clientY - startY) + 'px';
    }
    function onUp() {
      root.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // Shared resize logic
  function startResize(e, fromLeft) {
    e.preventDefault();
    e.stopPropagation();

    // Anchor to left so we can move it freely
    const rect = root.getBoundingClientRect();
    root.style.right = '';
    root.style.left = rect.left + 'px';

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = root.offsetWidth;
    const startH = root.offsetHeight;
    const startLeft = rect.left;

    function onMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (fromLeft) {
        const newW = Math.max(200, startW - dx);
        root.style.width = newW + 'px';
        root.style.left  = (startLeft + startW - newW) + 'px';
      } else {
        root.style.width = Math.max(200, startW + dx) + 'px';
      }

      const newH = Math.max(160, startH + dy);
      body.style.height = (newH - header.offsetHeight - footer.offsetHeight) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }

  resizeHandle.addEventListener('mousedown',   (e) => startResize(e, false));
  resizeHandleSW.addEventListener('mousedown', (e) => startResize(e, true));

  // Minimize / expand
  let minimized = false;
  minBtn.addEventListener('click', () => {
    minimized = !minimized;
    body.style.display = minimized ? 'none' : '';
    footer.style.display = minimized ? 'none' : '';
    minBtn.textContent = minimized ? '+' : '−';
  });

  // Send message
  function sendMessage() {
    const text = input.value.trim();
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    safeSend({ type: 'chat', text });
    input.value = '';
  }
  sendBtn.addEventListener('click', sendMessage);
  // Stop the game from capturing keystrokes while the input is focused
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') sendMessage();
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('keypress', (e) => e.stopPropagation());

  // Manual mode override — only takes effect while in a game
  modeSelect.addEventListener('change', () => {
    if (!inGame) return;
    const mode = modeSelect.value || detectMode();
    if (mode !== currentRoom) connectToRoom(mode);
  });
}

// ---- Message rendering ----

function appendMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_MESSAGES) messages.shift();

  const list = document.getElementById('sk-messages');
  if (!list) return;

  const row = el('div', 'sk-msg sk-msg-' + msg.type);

  const timeStr = msg.at
    ? new Date(msg.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  if (msg.type === 'chat') {
    row.append(
      el('span', 'sk-name', msg.from?.display_name ?? 'unknown'),
      el('span', 'sk-sep', ': '),
      el('span', 'sk-text', msg.text),
      el('span', 'sk-time', timeStr),
    );
  } else if (msg.type === 'system') {
    row.append(
      el('span', 'sk-sys-text', msg.text),
      el('span', 'sk-time', timeStr),
    );
  }

  list.appendChild(row);
  // Keep scroll pinned to bottom unless user has scrolled up
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ---- Status / connection indicator ----

function setStatus(connected, room) {
  const label = document.getElementById('sk-room');
  if (!label) return;
  if (connected) {
    label.textContent = '#' + (room ?? currentRoom ?? 'chat');
    label.className = 'sk-room connected';
  } else if (inGame) {
    label.textContent = 'Reconnecting…';
    label.className = 'sk-room disconnected';
  } else {
    label.textContent = 'Waiting for game…';
    label.className = 'sk-room disconnected';
  }
}

// ---- Safe runtime messaging ----
// After an extension reload the old content script's context is invalidated.
// Any chrome.runtime call then throws — guard every call site.

function runtimeValid() {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

function safeSend(msg) {
  if (!runtimeValid()) return;
  try {
    chrome.runtime.sendMessage(msg);
  } catch {
    // Context was invalidated between the check and the call; ignore.
  }
}

// ---- Room connection ----

function connectToRoom(mode) {
  currentRoom = mode;
  isConnected = false;
  const sel = document.getElementById('sk-mode-select');
  if (sel) sel.value = mode;
  // Prefer Firebase in-game username, then DOM detection
  const playName = firebasePlayerName ?? detectPlayerName();
  safeSend({ type: 'connect', mode, ...(playName && { playName }) });
}

// ---- Player name detection ----

function detectPlayerName() {
  // Look for the local player's username in common SmashKarts DOM locations.
  // These selectors target profile/account display elements.
  const selectors = [
    '[class*="username"]',
    '[class*="player-name"]',
    '[class*="playerName"]',
    '[class*="profile-name"]',
    '[class*="account-name"]',
    '[data-username]',
    '[data-player-name]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const name = (el?.dataset?.username ?? el?.dataset?.playerName ?? el?.textContent ?? '').trim();
    if (name && name.length >= 2 && name.length <= 32) return name;
  }
  return null;
}

// ---- Relay interceptor captures → background ----
// interceptor.js (MAIN world) posts via window.postMessage; we pick them up
// here (isolated world) and forward to the background service worker.

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data?.__sk_cap) return;
  if (!runtimeValid()) return;
  const { __sk_cap: _flag, ...entry } = e.data;

  if (entry.kind === 'player_name') {
    // Store the real in-game username from Firebase for use when connecting
    firebasePlayerName = entry.name;
    return;
  }

  if (entry.kind === 'game_active') {
    inGame = true;
    const mode = detectMode();
    connectToRoom(mode);
    return;
  }

  if (entry.kind === 'game_ended') {
    inGame = false;
    isConnected = false;
    safeSend({ type: 'disconnect' });
    setStatus(false);
    return;
  }

  try {
    chrome.runtime.sendMessage({ type: 'game_traffic', entry });
  } catch {
    // Context invalidated between check and call; ignore.
  }
});

// ---- Incoming messages from background ----

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'chat' || msg.type === 'system') {
    appendMessage(msg);
  } else if (msg.type === 'status') {
    isConnected = !!msg.connected;
    setStatus(msg.connected, msg.room);
    if (!msg.connected && msg.error === 'Auth failed') {
      safeSend({ type: 'auth_interactive' });
    }
  }
});

// ---- Reconnect heartbeat ----
// The MV3 service worker can be killed by Chrome, dropping the WS silently.
// Re-send connect when the tab regains focus or every 15s while disconnected.

function maybeReconnect() {
  if (!runtimeValid() || isConnected || !inGame || !currentRoom) return;
  const playName = firebasePlayerName ?? detectPlayerName();
  safeSend({ type: 'connect', mode: currentRoom, ...(playName && { playName }) });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') maybeReconnect();
});

setInterval(maybeReconnect, 15_000);

// ---- Init ----

function init() {
  if (document.getElementById('sk-chat-root')) return; // already injected
  buildOverlay();
  // Don't connect here — wait for the Photon /game/ WS to open (game_active event).
  // Firebase will deliver the player name before that happens.
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
