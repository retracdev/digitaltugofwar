const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');

test('each pull is worth 0.05%, so a win takes a 900-pull lead', () => {
  assert.equal(core.PULL_WORTH, 0.05);
  assert.equal(core.WIN_LEAD, 900);
  assert.equal(core.redPercent(0, 0), 50);
  assert.equal(core.redPercent(20, 0), 51);
  assert.equal(core.redPercent(0, 20), 49);
  assert.equal(core.redPercent(1, 0), 50.05);
  assert.equal(core.redPercent(900, 0), 95);
  assert.equal(core.redPercent(5000, 0), 95);
  assert.equal(core.redPercent(0, 5000), 5);
});

test('a round is won at a 900-pull lead, or by a win marker', () => {
  assert.equal(core.winner({ red: 899, blue: 0 }), null);
  assert.equal(core.winner({ red: 900, blue: 0 }), 'red');
  assert.equal(core.winner({ red: 1000, blue: 1900 }), 'blue');
  assert.equal(core.winner({ red: 5, blue: 5, wonRed: 1 }), 'red');
  assert.equal(core.winner({ red: 5000, blue: 0, wonBlue: 2 }), 'blue');
  // Both markers: the rope decides, and an exact tie goes to Red so everyone agrees.
  assert.equal(core.winner({ red: 10, blue: 20, wonRed: 1, wonBlue: 1 }), 'blue');
  assert.equal(core.winner({ red: 20, blue: 20, wonRed: 1, wonBlue: 1 }), 'red');
  // Junk from the network counts as nothing.
  assert.equal(core.winner({ red: -5, blue: 'x', wonRed: NaN }), null);
});

test('pulls to win counts down for whoever is ahead', () => {
  assert.equal(core.pullsToWin(10, 10), null);
  assert.deepEqual(core.pullsToWin(100, 40), { team: 'red', pulls: 840 });
  assert.deepEqual(core.pullsToWin(0, 899), { team: 'blue', pulls: 1 });
  assert.deepEqual(core.pullsToWin(0, 2000), { team: 'blue', pulls: 0 });
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
