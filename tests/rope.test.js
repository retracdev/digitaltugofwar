// Runs js/rope.js against an in-memory copy of the counters API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('../js/core.js');
const ropeSource = fs.readFileSync(path.join(__dirname, '../js/rope.js'), 'utf8');
const WEEK = core.weekKey(Date.now());
const name = (round, kind) => core.counterName(WEEK, round, kind);

function setup(seed = {}, storage = new Map()) {
  const counters = new Map(Object.entries(seed));
  const calls = [];
  const timers = [];
  const window = { TugCore: core, addEventListener() {} };
  const context = {
    window,
    document: { visibilityState: 'visible', addEventListener() {} },
    localStorage: {
      get length() { return storage.size; },
      key: (i) => Array.from(storage.keys())[i] ?? null,
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    performance: { now: () => Date.now() },
    AbortController,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Date,
    Error,
    Set,
    Map,
    Array,
    Boolean,
    console,
    encodeURIComponent,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    fetch: async (url, options) => {
      const [, op, counter] = url.match(/\/counters\/(get|increment)\/(.+)$/);
      const key = decodeURIComponent(counter);
      calls.push({ op, key, method: options.method });
      const count = (counters.get(key) || 0) + (op === 'increment' ? 1 : 0);
      counters.set(key, count);
      return { ok: true, status: 200, json: async () => ({ name: key, count }) };
    },
  };
  vm.runInNewContext(ropeSource, context);
  const rope = window.TugRope;
  const events = { round: [], win: [], change: [] };
  rope.on('round', (value) => events.round.push(value));
  rope.on('win', (value) => events.win.push(value));
  rope.on('change', (value) => events.change.push(value));
  // Lets every pending promise settle.
  const settle = () => new Promise((resolve) => setImmediate(resolve)).then(() => new Promise((r) => setImmediate(r)));
  return { rope, counters, calls, events, settle, timers };
}

test('a fresh week starts at round 0, even and live', async () => {
  const { rope, events, settle } = setup();
  rope.start();
  await settle();
  const snap = rope.snapshot();
  assert.equal(snap.status, 'live');
  assert.equal(snap.round, 0);
  assert.equal(snap.key, WEEK + '-r0');
  assert.equal(snap.redPercent, 50);
  assert.equal(events.round.length, 1);
});

test('a pull shows at once and is counted by one increment', async () => {
  const { rope, counters, calls, settle } = setup({ [name(0, 'blue')]: 40 });
  rope.start();
  await settle();
  assert.equal(rope.pull('red'), true);
  assert.equal(rope.snapshot().red, 1); // Before the API answers.
  await settle();
  assert.equal(counters.get(name(0, 'red')), 1);
  assert.equal(calls.filter((c) => c.op === 'increment').length, 1);
  assert.equal(calls.find((c) => c.op === 'increment').method, 'POST');
  const snap = rope.snapshot();
  assert.equal(snap.confirmed.red, 1);
  assert.equal(snap.counted.red, 1);
  assert.equal(snap.blue, 40);
  assert.equal(snap.redPercent, 50 + (1 - 40) / 20);
});

test('pulls faster than 8 a second are not counted', async () => {
  const { rope, settle } = setup();
  rope.start();
  await settle();
  const accepted = Array.from({ length: 12 }, () => rope.pull('blue')).filter(Boolean).length;
  assert.equal(accepted, 8);
  await settle();
  await settle();
  assert.equal(rope.snapshot().confirmed.blue, 8);
});

test('rounds already won are skipped, and a win seen first leaves a marker', async () => {
  const { rope, counters, settle } = setup({
    [name(0, 'red')]: 950, [name(0, 'blue')]: 10, // Won on the rope, no marker yet.
    [name(1, 'red')]: 3, [name(1, 'wonblue')]: 1, // Settled by a marker.
    [name(2, 'red')]: 7,
  });
  rope.start();
  await settle();
  const snap = rope.snapshot();
  assert.equal(snap.round, 2);
  assert.deepEqual([...snap.wins], ['red', 'blue']);
  assert.equal(snap.red, 7);
  assert.equal(counters.get(name(0, 'wonred')), 1);
  assert.equal(counters.get(name(1, 'wonblue')), 1); // Not marked again.
});

test('the winning pull ends the round and moves everyone to the next', async () => {
  const { rope, counters, events, timers, settle } = setup({ [name(0, 'red')]: 899 });
  rope.start();
  await settle();
  assert.equal(rope.pull('red'), true);
  await settle();
  assert.equal(events.win.length, 1);
  assert.equal(events.win[0].team, 'red');
  assert.equal(events.win[0].round, 0);
  assert.equal(counters.get(name(0, 'wonred')), 1);
  assert.equal(rope.pull('red'), false); // No round until the next one is found.
  timers.splice(0).forEach((fn) => fn());
  await settle();
  const snap = rope.snapshot();
  assert.equal(snap.round, 1);
  assert.equal(snap.red, 0);
  assert.deepEqual([...snap.wins], ['red']);
  assert.equal(events.round.at(-1).key, WEEK + '-r1');
});

test('a later visit starts from the round this browser already knew', async () => {
  const storage = new Map();
  const seed = { [name(0, 'wonblue')]: 1 };
  const first = setup(seed, storage);
  first.rope.start();
  await first.settle();
  assert.equal(first.rope.snapshot().round, 1);
  const second = setup(seed, storage);
  second.rope.start();
  await second.settle();
  assert.equal(second.rope.snapshot().round, 1);
  assert.deepEqual([...second.rope.snapshot().wins], ['blue']);
  assert.ok(!second.calls.some((c) => c.key.includes('-r0-')));
});

test('each ticket is a fresh number from the round\'s joins counter', async () => {
  const { rope, counters, settle } = setup({ [name(0, 'joins')]: 4 });
  rope.start();
  await settle();
  const first = await rope.ticket();
  const second = await rope.ticket();
  assert.equal(counters.get(name(0, 'joins')), 6);
  assert.equal(first.key, WEEK + '-r0');
  assert.equal(first.team, 'red'); // Ticket 5.
  assert.equal(second.team, 'blue'); // Ticket 6.
});
