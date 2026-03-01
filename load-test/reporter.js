'use strict';

class Reporter {
  constructor() {
    this.samples = [];
  }

  record(ms) {
    this.samples.push(ms);
  }

  percentile(p) {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  // Returns true if the run passes its SLOs.
  print({ profile, sent, expected, received, p99Max, dropMax }) {
    const dropped  = Math.max(0, expected - received);
    const dropPct  = expected > 0 ? (dropped / expected) * 100 : 0;
    const n        = this.samples.length;
    const min      = n > 0 ? Math.min(...this.samples) : 0;
    const p50      = this.percentile(50);
    const p95      = this.percentile(95);
    const p99      = this.percentile(99);
    const max      = n > 0 ? Math.max(...this.samples) : 0;

    const latencyOk = p99 <= p99Max;
    const dropOk    = dropPct <= dropMax;
    const pass      = latencyOk && dropOk;

    console.log('');
    console.log('SmashKarts Chat Load Test');
    console.log('=========================');
    console.log(`Profile:       ${profile}`);
    console.log('');
    console.log('Messages');
    console.log(`  Sent:        ${sent.toLocaleString()}`);
    console.log(`  Expected:    ${expected.toLocaleString()}`);
    console.log(`  Received:    ${received.toLocaleString()}`);
    console.log(`  Dropped:     ${dropped.toLocaleString()}  (${dropPct.toFixed(3)}%)`);
    console.log('');
    console.log('Latency (ms)');
    console.log(`  min:         ${min}`);
    console.log(`  p50:         ${p50}`);
    console.log(`  p95:         ${p95}`);
    console.log(`  p99:         ${p99}${latencyOk ? '' : `  [FAIL > ${p99Max}ms]`}`);
    console.log(`  max:         ${max}`);
    console.log('');
    console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    if (!latencyOk) console.log(`    p99 ${p99}ms exceeds threshold ${p99Max}ms`);
    if (!dropOk)    console.log(`    drop ${dropPct.toFixed(3)}% exceeds threshold ${dropMax}%`);
    console.log('');

    return pass;
  }
}

module.exports = Reporter;
