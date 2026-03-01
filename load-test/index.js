'use strict';

const WebSocket = require('ws');
const http      = require('http');
const Reporter  = require('./reporter');

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : def;
}

const connections = parseInt(flag('connections', '10'),  10);
const intervalMs  = parseInt(flag('interval',    '500'), 10);
const durationSec = parseInt(flag('duration',    '60'),  10);
const churnSec    = parseInt(flag('churn',       '0'),   10);
const room        = flag('room',     'stress-test');
const p99Max      = parseInt(flag('p99-max',  '200'), 10);
const dropMax     = parseFloat(flag('drop-max', '1.0'));
const host        = flag('server', 'localhost:8080');

// ── State ─────────────────────────────────────────────────────────────────────
const reporter = new Reporter();
let sent     = 0;
let received = 0;
let connOk   = 0;
let connFail = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function wsUrl(i) {
  const id   = encodeURIComponent(`load-${i}`);
  const name = encodeURIComponent(`LoadClient${i}`);
  return `ws://${host}/ws?mode=${encodeURIComponent(room)}&provider=play&play_id=${id}&play_name=${name}`;
}

function makeClient(i) {
  const ws = new WebSocket(wsUrl(i));
  let opened = false;

  ws.on('open',  () => { opened = true; connOk++; });
  ws.on('error', () => { if (!opened) connFail++; });

  // Only receiver clients (index > 0) record latency.
  // The sender's own echo is excluded to match expected = sent × (N-1).
  if (i > 0) {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'chat' && msg.at) {
          const latency = Date.now() - new Date(msg.at).getTime();
          if (latency >= 0) reporter.record(latency);
          received++;
        }
      } catch (_) {}
    });
  }

  return ws;
}

function closeQuietly(ws) {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  } catch (_) {}
}

function pollMetrics() {
  const req = http.get(`http://${host}/metrics`, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const m = JSON.parse(body);
        process.stdout.write(
          `[metrics] rooms=${m.rooms} total_conns=${m.total_connections} ` +
          `broadcast=${m.messages_broadcast} uptime=${m.uptime_secs}s\n`
        );
      } catch (_) {}
    });
  });
  req.on('error', () => {}); // server may not be ready yet
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const profile = `${connections} connections, ${intervalMs}ms interval, ${durationSec}s`;
  console.log(`\nStarting load test`);
  console.log(`  Profile: ${profile}`);
  console.log(`  Room:    ${room}  |  Server: ${host}`);
  console.log(`  SLOs:    p99 < ${p99Max}ms, drop < ${dropMax}%`);
  if (churnSec > 0) console.log(`  Churn:   reconnect every ${churnSec}s`);
  console.log('');

  // ── Connect all clients ───────────────────────────────────────────────────
  const clients = [];

  await new Promise((resolve) => {
    let settled = 0;
    const done = () => { if (++settled >= connections) resolve(); };

    for (let i = 0; i < connections; i++) {
      const ws = makeClient(i);
      clients.push(ws);

      // Each socket resolves the promise exactly once (open or first error).
      let counted = false;
      const once = () => { if (!counted) { counted = true; done(); } };
      ws.once('open',  once);
      ws.once('error', once);
    }

    // Safety: resolve after 8 s even if some connections time out.
    setTimeout(resolve, 8000);
  });

  console.log(`Connections:  ${connOk} ok, ${connFail} failed`);
  if (connOk === 0) {
    console.error('No connections established — is the server running?');
    process.exit(1);
  }

  // ── Sender (client 0) ─────────────────────────────────────────────────────
  const sendInterval = setInterval(() => {
    const ws = clients[0];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat', text: `ping@${Date.now()}` }));
      sent++;
    }
  }, intervalMs);

  // ── /metrics poll ─────────────────────────────────────────────────────────
  const metricsInterval = setInterval(pollMetrics, 5000);

  // ── Churn ─────────────────────────────────────────────────────────────────
  let churnInterval = null;
  if (churnSec > 0) {
    churnInterval = setInterval(() => {
      for (let i = 0; i < clients.length; i++) {
        closeQuietly(clients[i]);
        clients[i] = makeClient(i);
      }
    }, churnSec * 1000);
  }

  // ── Run for `duration` seconds ────────────────────────────────────────────
  await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));

  // ── Teardown ──────────────────────────────────────────────────────────────
  clearInterval(sendInterval);
  clearInterval(metricsInterval);
  if (churnInterval) clearInterval(churnInterval);
  for (const ws of clients) closeQuietly(ws);

  // Allow in-flight messages to land before printing results.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // ── Report ────────────────────────────────────────────────────────────────
  // expected = messages the sender broadcast × number of receiver clients.
  // Receiver clients = all connections except the sender (index 0).
  const receivers = Math.max(connOk - 1, 0);
  const expected  = sent * receivers;

  const pass = reporter.print({ profile, sent, expected, received, p99Max, dropMax });
  process.exit(pass ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
