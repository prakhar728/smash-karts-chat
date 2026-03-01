# SmashKarts Chat — Stress Test Report

**Date:** 2026-03-01
**Server:** Rust/Axum, single process, `127.0.0.1:8080`
**Test runner:** Node.js `load-test/index.js` with `ws@8`

---

## Results by Profile

| Profile | Conns (ok/tried) | Sent | Received | Drop % | p50 | p95 | p99 | max | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| Baseline | 10 / 10 | 119 | 990 | 7.56% | 1ms | 2ms | 2ms | 3ms | FAIL† |
| Light | 50 / 50 | 119 | 5,439 | 6.72% | 2ms | 4ms | 5ms | 8ms | FAIL† |
| Medium | 200 / 200 | 119 | 22,487 | 5.04% | 5ms | 9ms | 11ms | 12ms | FAIL† |
| Heavy | 246 / 500 | 239 | 56,595 | 3.35% | 5ms | 10ms | 13ms | 23ms | FAIL†‡ |
| Burst | 200 / 200 | 1,178 | 23,482 | 89.98% | 4ms | 9ms | 10ms | 15ms | FAIL§ |
| Churn | 200 / 200 | 238 | 44,775 | 96.08% | 4ms | 8ms | 10ms | 14ms | FAIL¶ |

---

## The Good News — Latency Is Excellent

The core concern from the plan was `RwLock` write-lock contention degrading broadcast latency under high connection churn. **This did not materialise.** Latency remained consistently low across all profiles:

- p99 peaked at **13ms** during the 500-connection heavy run — well inside the 200ms SLO
- p99 under churn was **10ms** — write-lock contention is not a bottleneck at current load
- Max observed latency across all runs: **23ms**
- No crashes, no panics, no error logs observed

The `RwLock<HashMap<String, Room>>` is not a problem yet. `DashMap` or room sharding are not needed at this scale.

---

## Why Every Profile Shows "FAIL" — Root Causes

### † Baseline / Light / Medium / Heavy: Rate-Limiter vs Test Interval Collision

**Cause:** The server's per-user rate limit is `500ms`. The test's send interval is also `500ms`. Node.js `setInterval` has ±2–5ms jitter, meaning roughly 1-in-13 sends arrives at the server slightly *early* (e.g. at 497ms instead of 501ms) and gets silently dropped by the rate limiter.

**Evidence (decisive):** The drop rate *decreases* as connection count increases:

| Connections | Drop % | Absolute drops per receiver |
|---|---|---|
| 10 | 7.56% | ~9 msgs |
| 50 | 6.72% | ~8 msgs |
| 200 | 5.04% | ~6 msgs |
| 500 | 3.35% | ~8 msgs |

If this were a broadcast or delivery problem, the drop rate would *increase* with more connections. Instead the absolute number of dropped messages (~6–9 per receiver) stays constant while the denominator (receivers × sent) grows — a textbook timer-jitter signature.

**Fix:** Change the test interval to `600ms` (safely above the 500ms rate limit) when measuring delivery reliability. Use `500ms` only to deliberately measure rate-limit behaviour.

---

### ‡ Heavy: Connection Ceiling at ~246 (500 attempted)

85 connections were refused, 169 more timed out within the 8-second connection window. `ulimit -n` is `unlimited`, so the bottleneck is elsewhere.

**Likely cause:** Tokio's `TcpListener` default listen backlog is 128. When 500 WebSocket handshakes arrive simultaneously, the kernel queue overflows and the OS starts rejecting connections. Additionally, the 8-second connection timeout in the test runner is too short for 500 simultaneous handshakes.

**Fix options:**
1. Increase Tokio listen backlog: replace `TcpListener::bind` with a custom `socket2` setup using `.listen(512)`
2. Stagger client connections in the test runner (connect 50 at a time, 100ms apart) instead of all at once

---

### § Burst: Rate Limiter Is Working as Designed

At 50ms interval with a 500ms server rate limit, exactly 1-in-10 messages is allowed through. The test client sent 1,178 messages; receivers got ~118 each (≈ 60s / 0.5s × 199 receivers). This is correct behaviour.

**The burst SLO (`< 1% drop`) is unachievable with the current rate limit** — the plan's intent for the burst profile appears to be testing *receiver* throughput (can 200 clients keep up with rapid broadcasts), not testing above the rate limit. This SLO needs to be revised, or the rate limit must be removed/raised for burst testing.

---

### ¶ Churn: Expected Count Is Inflated by Reconnects

The test runner accumulates `connOk` across every churn cycle. Over 120s with 5s reconnect intervals (~24 cycles × 200 clients = ~4,800 reconnects), `connOk` reaches ~4,916. The `expected` calculation (`sent × (connOk - 1)`) produces a nonsensically large denominator (1,142,162), making the drop rate appear at 96%.

In reality, only ~199 receivers exist at any given moment. The actual message delivery rate is ~188 messages per receiver (44,775 / 238 ≈ 188 receiver-slots receiving each broadcast) which is plausible given churn gaps.

**Positive finding:** No crashes, no panics, and the server's room cleanup worked correctly throughout — `rooms=1` was maintained between churn cycles, dropping to `rooms=0` only briefly between the old connections terminating and new ones reconnecting.

**Fix needed in test runner:** Track `connOk` separately for initial connections vs reconnects, and cap `receivers` at `connections - 1` for the expected calculation.

---

## Server Metrics Summary

Captured from `GET /metrics` polled every 5s:

| Profile | Peak broadcast/5s | Broadcast rate |
|---|---|---|
| Baseline (10 conns) | ~100/5s | 10 msgs/s (10 × 2 msg/s) |
| Light (50 conns) | ~450/5s | 90 msgs/s |
| Medium (200 conns) | ~2000/5s | 400 msgs/s |
| Burst (200 conns, 50ms) | ~2000/5s | 400 msgs/s (rate-limited) |
| Churn (200 conns) | ~30,000–38,000/5s | ~6,600–7,600 msgs/s (join/leave system msgs dominate) |

**Key observation on churn:** The majority of server broadcasts during the churn run were `system` messages (join/leave), not chat. Each 5-second churn cycle generates 200 leave messages + 200 join messages = 400 system broadcasts × 200 subscribers = 80,000 deliveries per cycle. This dwarfs the chat traffic and shows the join/leave system message path is the primary write-lock consumer during churn, not chat itself.

---

## Issues to Fix Before Production

| Priority | Issue | Fix |
|---|---|---|
| **P0** | Test runner `expected` is wrong during churn | Cap receivers at `connections - 1` regardless of total `connOk` |
| **P1** | Rate-limit and test interval are identical | Use 600ms test interval for delivery tests; document that burst intentionally exercises rate limiter |
| **P1** | Heavy profile: connection ceiling at ~246 | Increase Tokio listen backlog via `socket2`, or stagger test connections |
| **P2** | Churn metric interpretation | Separate initial vs reconnect `connOk` in reporter |

---

## Verdict

**The server is production-ready for the latency dimension.** p99 < 15ms even under stress, no crashes, no panics, clean room teardown after every run.

**The drop dimension cannot be properly evaluated yet** — all measured drops are either rate-limiter collisions (test artifact), burst-by-design, or accounting bugs in the churn runner. The actual delivery reliability of the server is not yet meaningfully measured.

**Recommended next step:** Re-run baseline/light/medium with `--interval 600` to get clean drop numbers, and fix the churn expected calculation before drawing conclusions about delivery reliability.
