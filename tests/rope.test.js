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
  const events = { round: [], win: [], change: [], pulled: [] };
  rope.on('round', (value) => events.round.push(value));
  rope.on('win', (value) => events.win.push(value));
  rope.on('change', (value) => events.change.push(value));
  rope.on('pulled', (value) => events.pulled.push(value));
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

// The smallest number of mega pulls on `counter` that adds up to at least `units`.
function megasFor(counter, units) {
  let n = 0;
  while (core.unitsBetween(counter, 0, n) < units) n++;
  return n;
}

test('a pull shows at once, then counts at the strength its number decides', async () => {
  const { rope, counters, calls, events, settle } = setup({ [name(0, 'blue')]: 40 });
  rope.start();
  await settle();
  const blue = core.unitsBetween(name(0, 'blue'), 0, 40);
  assert.equal(rope.pull('red', { x: 1, y: 2 }), true);
  assert.equal(rope.snapshot().red, 5.5); // Before the API answers: an average pull.
  await settle();
  assert.equal(counters.get(name(0, 'red')), 1);
  assert.equal(calls.filter((c) => c.op === 'increment').length, 1);
  assert.equal(calls.find((c) => c.op === 'increment').method, 'POST');
  const units = core.pullUnits(name(0, 'red'), 1);
  assert.equal(events.pulled.length, 1);
  assert.equal(events.pulled[0].units, units);
  assert.equal(events.pulled[0].mega, false);
  assert.equal(events.pulled[0].meta.x, 1);
  const snap = rope.snapshot();
  assert.equal(snap.red, units);
  assert.equal(snap.blue, blue);
  assert.equal(snap.mineUnits.red, units);
  assert.equal(snap.mine.red, 1);
  assert.equal(snap.redPercent, core.redPercent(units, blue));
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

test('a mega pull uses its own counter, and then has to recharge', async () => {
  const { rope, counters, events, settle } = setup();
  rope.start();
  await settle();
  assert.equal(rope.megaReady(), true);
  assert.equal(rope.megaPull('blue'), true);
  assert.equal(rope.snapshot().blue, 75); // An average mega pull until it's counted.
  assert.equal(rope.megaReady(), false);
  assert.equal(rope.megaPull('blue'), false);
  assert.ok(rope.snapshot().megaReadyAt > Date.now());
  await settle();
  const units = core.pullUnits(name(0, 'bluemega'), 1);
  assert.ok(units >= 50 && units <= 100);
  assert.equal(counters.get(name(0, 'bluemega')), 1);
  assert.equal(counters.get(name(0, 'blue')) || 0, 0); // Read, never pulled.
  assert.equal(events.pulled[0].mega, true);
  assert.equal(rope.snapshot().blue, units);
  // Ordinary pulls still work while it recharges.
  assert.equal(rope.pull('blue'), true);
});

test('rounds already won are skipped, and a win seen first leaves a marker', async () => {
  const megas = megasFor(name(0, 'redmega'), 4600);
  const { rope, counters, settle } = setup({
    [name(0, 'redmega')]: megas, [name(0, 'blue')]: 10, // Won on the rope, no marker yet.
    [name(1, 'red')]: 3, [name(1, 'wonblue')]: 1, // Settled by a marker.
    [name(2, 'red')]: 7,
  });
  rope.start();
  await settle();
  const snap = rope.snapshot();
  assert.equal(snap.round, 2);
  assert.deepEqual([...snap.wins], ['red', 'blue']);
  assert.equal(snap.red, core.unitsBetween(name(2, 'red'), 0, 7));
  assert.equal(counters.get(name(0, 'wonred')), 1);
  assert.equal(counters.get(name(1, 'wonblue')), 1); // Not marked again.
});

test('the winning pull ends the round and moves everyone to the next', async () => {
  // Just short of a win, so the next mega pull is bound to cross the line.
  const counter = name(0, 'redmega');
  const short = megasFor(counter, core.WIN_LEAD) - 1;
  assert.ok(core.unitsBetween(counter, 0, short) < core.WIN_LEAD);
  assert.ok(core.unitsBetween(counter, 0, short + 1) >= core.WIN_LEAD);
  const { rope, counters, events, timers, settle } = setup({ [counter]: short });
  rope.start();
  await settle();
  assert.equal(rope.snapshot().toWin.team, 'red');
  assert.equal(rope.megaPull('red'), true);
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
