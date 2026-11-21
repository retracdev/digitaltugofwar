const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');

test('rope strength is counted in units of 0.01%, and a win takes a 45% lead', () => {
  assert.equal(core.UNITS_PER_PERCENT, 100);
  assert.equal(core.WIN_LEAD, 4500);
  assert.equal(core.redPercent(0, 0), 50);
  assert.equal(core.redPercent(100, 0), 51);
  assert.equal(core.redPercent(0, 100), 49);
  assert.equal(core.redPercent(7, 0), 50.07);
  assert.equal(core.redPercent(4500, 0), 95);
  assert.equal(core.redPercent(99999, 0), 95);
  assert.equal(core.redPercent(0, 99999), 5);
  assert.equal(core.formatUnits(7), '0.07%');
  assert.equal(core.formatUnits(83), '0.83%');
  assert.equal(core.formatUnits(1235), '12.35%');
});

test('ordinary pulls are 0.01–0.10% and mega pulls 0.50–1.00%, looking random', () => {
  const name = core.counterName('2026w47', 0, 'red');
  const mega = core.counterName('2026w47', 0, 'redmega');
  const pulls = Array.from({ length: 20000 }, (_, i) => core.pullUnits(name, i + 1));
  const megas = Array.from({ length: 20000 }, (_, i) => core.pullUnits(mega, i + 1));
  assert.ok(pulls.every((u) => Number.isInteger(u) && u >= 1 && u <= 10));
  assert.ok(megas.every((u) => Number.isInteger(u) && u >= 50 && u <= 100));
  // Every strength turns up, about equally often.
  for (let u = 1; u <= 10; u++) {
    const share = pulls.filter((v) => v === u).length / pulls.length;
    assert.ok(share > 0.08 && share < 0.12, 'strength ' + u + ' turns up ' + share);
  }
  assert.equal(new Set(megas).size, 51);
  const mean = pulls.reduce((a, b) => a + b, 0) / pulls.length;
  assert.ok(Math.abs(mean - 5.5) < 0.1, 'mean ' + mean);
  // No obvious pattern from one pull to the next.
  const repeats = pulls.slice(1).filter((u, i) => u === pulls[i]).length / (pulls.length - 1);
  assert.ok(repeats > 0.07 && repeats < 0.13, 'repeats ' + repeats);
});

test('everyone works out the same strength for the same pull', () => {
  const name = core.counterName('2026w47', 3, 'blue');
  assert.equal(core.pullUnits(name, 42), core.pullUnits(name, 42));
  // Different counters (teams, rounds, weeks) don't share a sequence.
  const a = Array.from({ length: 50 }, (_, i) => core.pullUnits(name, i + 1)).join();
  const b = Array.from({ length: 50 }, (_, i) => core.pullUnits(core.counterName('2026w47', 3, 'red'), i + 1)).join();
  const c = Array.from({ length: 50 }, (_, i) => core.pullUnits(core.counterName('2026w48', 3, 'blue'), i + 1)).join();
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('a tally adds up only the new pulls, and matches adding them all', () => {
  const name = core.counterName('2026w47', 0, 'bluemega');
  const tally = core.createTally();
  assert.equal(tally(name, 0), 0);
  assert.equal(tally(name, 10), core.unitsBetween(name, 0, 10));
  assert.equal(tally(name, 10), core.unitsBetween(name, 0, 10));
  assert.equal(tally(name, 250), core.unitsBetween(name, 0, 250));
  assert.equal(core.unitsBetween(name, 0, 3), core.pullUnits(name, 1) + core.pullUnits(name, 2) + core.pullUnits(name, 3));
});

test('a round is won at a 4,500-unit lead, or by a win marker', () => {
  assert.equal(core.winner({ red: 4499, blue: 0 }), null);
  assert.equal(core.winner({ red: 4500, blue: 0 }), 'red');
  assert.equal(core.winner({ red: 1000, blue: 5500 }), 'blue');
  assert.equal(core.winner({ red: 5, blue: 5, wonRed: 1 }), 'red');
  assert.equal(core.winner({ red: 9000, blue: 0, wonBlue: 2 }), 'blue');
  // Both markers: the rope decides, and an exact tie goes to Red so everyone agrees.
  assert.equal(core.winner({ red: 10, blue: 20, wonRed: 1, wonBlue: 1 }), 'blue');
  assert.equal(core.winner({ red: 20, blue: 20, wonRed: 1, wonBlue: 1 }), 'red');
  // Junk from the network counts as nothing.
  assert.equal(core.winner({ red: -5, blue: 'x', wonRed: NaN }), null);
});

test('the distance to a win counts down for whoever is ahead', () => {
  assert.equal(core.unitsToWin(10, 10), null);
  assert.deepEqual(core.unitsToWin(1000, 400), { team: 'red', units: 3900 });
  assert.deepEqual(core.unitsToWin(0, 4499), { team: 'blue', units: 1 });
  assert.deepEqual(core.unitsToWin(0, 9000), { team: 'blue', units: 0 });
  // Pulls still on their way count at an average strength, so totals can be fractional.
  assert.deepEqual(core.unitsToWin(5.5, 0), { team: 'red', units: 4494 });
});

test('weeks are ISO weeks that start on Monday 00:00 UTC', () => {
  assert.equal(core.weekKey(Date.UTC(2026, 10, 21, 12)), '2026w47');
  assert.equal(core.weekKey(Date.UTC(2026, 10, 16, 0, 0, 0)), '2026w47');
  assert.equal(core.weekKey(Date.UTC(2026, 10, 15, 23, 59, 59)), '2026w46');
  assert.equal(core.weekKey(Date.UTC(2027, 0, 1)), '2026w53');
  assert.equal(core.weekKey(Date.UTC(2021, 0, 3)), '2020w53');
  assert.equal(core.weekKey(Date.UTC(2026, 0, 1)), '2026w01');
  assert.equal(core.weekStart(Date.UTC(2026, 10, 21, 12)), Date.UTC(2026, 10, 16));
  assert.equal(core.weekEnd(Date.UTC(2026, 10, 21, 12)), Date.UTC(2026, 10, 23));
});

test('counter names are valid for the counters API', () => {
  const name = core.counterName('2026w47', 3, 'wonblue');
  assert.equal(name, 'tugofwar-2026w47-r3-wonblue');
  assert.match(name, /^[a-zA-Z0-9_-]+$/);
  assert.equal(core.roundKey('2026w47', 3), '2026w47-r3');
});

test('a team cookie only counts for its own round', () => {
  const cookies = 'other=1; tugofwar-team=' + encodeURIComponent('2026w47-r3.blue') + '; x=y';
  assert.equal(core.parseTeamCookie(cookies, 'tugofwar-team', '2026w47-r3'), 'blue');
  assert.equal(core.parseTeamCookie(cookies, 'tugofwar-team', '2026w47-r4'), null);
  assert.equal(core.parseTeamCookie(cookies, 'tugofwar-team', '2026w48-r3'), null);
  assert.equal(core.parseTeamCookie('tugofwar-team=2026w47-r3.green', 'tugofwar-team', '2026w47-r3'), null);
  assert.equal(core.parseTeamCookie('tugofwar-team=%E0%A4%A', 'tugofwar-team', '2026w47-r3'), null);
  assert.equal(core.parseTeamCookie('', 'tugofwar-team', '2026w47-r3'), null);
});

test('a cloud save only counts for its own round', () => {
  const save = { version: 1, round: '2026w47-r0', team: 'red', joinedAt: 1 };
  assert.equal(core.teamFromSave(save, '2026w47-r0'), 'red');
  assert.equal(core.teamFromSave(save, '2026w47-r1'), null);
  assert.equal(core.teamFromSave({ ...save, version: 2 }, '2026w47-r0'), null);
  assert.equal(core.teamFromSave({ ...save, team: 'green' }, '2026w47-r0'), null);
  assert.equal(core.teamFromSave(null, '2026w47-r0'), null);
  assert.equal(core.teamFromSave([], '2026w47-r0'), null);
});

test('team tickets alternate, and the first ticket swaps teams every round', () => {
  const round0 = [1, 2, 3, 4, 5, 6].map((ticket) => core.teamForTicket(ticket, 0));
  assert.deepEqual(round0, ['red', 'blue', 'red', 'blue', 'red', 'blue']);
  assert.equal(core.teamForTicket(1, 1), 'blue');
  assert.equal(core.teamForTicket(2, 1), 'red');
  // Any run of tickets splits evenly, however big the crowd.
  const crowd = Array.from({ length: 101 }, (_, i) => core.teamForTicket(i + 1, 7));
  assert.ok(Math.abs(crowd.filter((t) => t === 'red').length - crowd.filter((t) => t === 'blue').length) <= 1);
});
