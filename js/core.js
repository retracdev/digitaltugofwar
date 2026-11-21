/*
 * The rules of the rope, kept free of the page so they can be tested in Node.
 *
 * Every pull is one increment of a public retrac.space counter. Each team has two counters per
 * round: tugofwar-<week>-r<round>-red for ordinary pulls and tugofwar-<week>-r<round>-redmega
 * for mega pulls (and the same for blue). Counters can only go up and can't be reset, so a
 * fresh round or week simply uses fresh counter names.
 *
 * How hard a pull is: counters only count, so a pull can't carry an amount. Instead, every
 * increment gets back its own number (the 1st pull, the 2nd, ...), and the strength of pull
 * number n is a scrambled hash of the counter's name and n. It looks random, but everyone
 * works out the same strength for the same pull, so everyone agrees where the rope is.
 *
 *   - an ordinary pull moves the rope 0.01% to 0.10%
 *   - a mega pull (hold to charge) moves it 0.50% to 1.00%
 *
 * Strengths are counted in units of 0.01%. The rope sits at 50% and moves toward whichever
 * team has pulled harder in total. A team wins the round when the rope reaches WIN_PERCENT
 * on its side, which takes a lead of WIN_LEAD units (45%). Rounds also end when the week ends
 * (Monday 00:00 UTC), because the week is part of every counter name.
 *
 * The lead can shrink again after a win if pulls were still on their way, so the first
 * visitor to see a win also increments a "won" marker counter for that round. A marker
 * that's above zero settles the round for good, whatever the pulls say later.
 */
(function (root) {
  'use strict';

  const UNITS_PER_PERCENT = 100; // One unit is 0.01% of rope.
  const PULL_UNITS = [1, 10]; // An ordinary pull: 0.01% to 0.10%.
  const MEGA_UNITS = [50, 100]; // A mega pull: 0.50% to 1.00%.
  const MEGA_HOLD_MS = 1500; // How long to hold to charge a mega pull.
  const MEGA_COOLDOWN_MS = 8000; // How long after a mega pull before charging another.
  const WIN_PERCENT = 95;
  const WIN_LEAD = (WIN_PERCENT - 50) * UNITS_PER_PERCENT; // 4,500 units, so 45%.
  const TEAMS = ['red', 'blue'];
  const PREFIX = 'tugofwar';
  const DAY_MS = 86400000;

  // Monday 00:00 UTC of the week containing `ms`.
  function weekStart(ms) {
    const date = new Date(ms);
    const sinceMonday = (date.getUTCDay() + 6) % 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - sinceMonday * DAY_MS;
  }

  function weekEnd(ms) {
    return weekStart(ms) + 7 * DAY_MS;
  }

  // ISO 8601 week, like "2026w47". The year is the one that week's Thursday falls in.
  function weekKey(ms) {
    const thursday = weekStart(ms) + 3 * DAY_MS;
    const year = new Date(thursday).getUTCFullYear();
    const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
    return year + 'w' + String(week).padStart(2, '0');
  }

  function isTeam(value) {
    return TEAMS.includes(value);
  }

  function otherTeam(team) {
    return team === 'red' ? 'blue' : 'red';
  }

  function roundKey(week, round) {
    return week + '-r' + round;
  }

  // kind is a team's pulls ("red", "blue"), its mega pulls ("redmega", "bluemega"), its win
  // marker ("wonred", "wonblue"), or the round's team tickets ("joins").
  function counterName(week, round, kind) {
    return PREFIX + '-' + week + '-r' + round + '-' + kind;
  }

  function count(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  // ---------- How hard each pull is ----------

  // FNV-1a, then a murmur3 finish, so neighbouring pulls get unrelated strengths.
  function hashName(name) {
    let hash = 2166136261;
    for (let i = 0; i < name.length; i++) {
      hash ^= name.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function scramble(value) {
    let x = value >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    return x >>> 0;
  }

  function isMega(name) {
    return name.endsWith('mega');
  }

  // The strength, in units, of pull number `index` (1, 2, 3, ...) on the counter `name`.
  function pullUnits(name, index) {
    const [min, max] = isMega(name) ? MEGA_UNITS : PULL_UNITS;
    const roll = scramble(hashName(name) ^ Math.imul(index, 0x9e3779b1));
    return min + (roll % (max - min + 1));
  }

  // The total strength of pulls `from + 1` through `to` on the counter `name`.
  function unitsBetween(name, from, to) {
    let total = 0;
    for (let i = count(from) + 1; i <= to; i++) total += pullUnits(name, i);
    return total;
  }

  // Keeps running totals per counter, so each new poll only adds up the new pulls.
  function createTally() {
    const totals = new Map(); // counter name -> { count, units }
    return function unitsFor(name, pulls) {
      const total = count(pulls);
      const known = totals.get(name) || { count: 0, units: 0 };
      if (total === known.count) return known.units;
      if (total < known.count) return unitsBetween(name, 0, total); // Counts never go down, but just in case.
      const next = { count: total, units: known.units + unitsBetween(name, known.count, total) };
      totals.set(name, next);
      return next.units;
    };
  }

  // Midpoints, used for pulls still on their way, whose strength isn't known yet.
  const EXPECTED_PULL_UNITS = (PULL_UNITS[0] + PULL_UNITS[1]) / 2;
  const EXPECTED_MEGA_UNITS = (MEGA_UNITS[0] + MEGA_UNITS[1]) / 2;

  // ---------- The rope ----------

  // How far Red has the rope, from 5 to 95, given each team's total strength in units.
  function redPercent(red, blue) {
    const percent = 50 + (Number(red || 0) - Number(blue || 0)) / UNITS_PER_PERCENT;
    if (!Number.isFinite(percent)) return 50;
    return Math.min(WIN_PERCENT, Math.max(100 - WIN_PERCENT, percent));
  }

  // The team that has won this round, or null while it's still going. red and blue are units.
  function winner(totals) {
    const red = count(totals.red);
    const blue = count(totals.blue);
    const wonRed = count(totals.wonRed) > 0;
    const wonBlue = count(totals.wonBlue) > 0;
    // Both markers can only happen if two visitors saw opposite wins at nearly the same
    // instant. The rope decides, and Red takes an exact tie so everyone agrees.
    if (wonRed && wonBlue) return blue > red ? 'blue' : 'red';
    if (wonRed) return 'red';
    if (wonBlue) return 'blue';
    if (red - blue >= WIN_LEAD) return 'red';
    if (blue - red >= WIN_LEAD) return 'blue';
    return null;
  }

  // Nobody picks a side: each new player takes the next ticket from the round's "joins"
  // counter, and tickets alternate between the teams. The counter hands every caller a
  // different number, so even a crowd arriving at once splits evenly. Which team gets the
  // first ticket swaps every round.
  function teamForTicket(ticket, round) {
    return (count(ticket) + count(round)) % 2 === 1 ? 'red' : 'blue';
  }

  // How far (in units) the leading team still has to pull, or null when it's even.
  function unitsToWin(red, blue) {
    const lead = Math.round(Number(red || 0) - Number(blue || 0));
    if (!lead) return null;
    return { team: lead > 0 ? 'red' : 'blue', units: Math.max(0, WIN_LEAD - Math.abs(lead)) };
  }

  // "0.07%" for 7 units.
  function formatUnits(units) {
    return (units / UNITS_PER_PERCENT).toFixed(2) + '%';
  }

  // The team cookie holds "<round key>.<team>", so it means nothing once the round is over.
  function parseTeamCookie(cookieHeader, name, key) {
    if (typeof cookieHeader !== 'string' || !key) return null;
    const prefix = name + '=';
    const entry = cookieHeader.split(/;\s*/).find((part) => part.startsWith(prefix));
    if (!entry) return null;
    let value;
    try {
      value = decodeURIComponent(entry.slice(prefix.length));
    } catch (error) {
      return null;
    }
    const dot = value.lastIndexOf('.');
    if (dot < 0 || value.slice(0, dot) !== key) return null;
    const team = value.slice(dot + 1);
    return isTeam(team) ? team : null;
  }

  // A cloud save is { version: 1, round, team, joinedAt }. Anything else is ignored.
  function teamFromSave(save, key) {
    if (!save || typeof save !== 'object' || Array.isArray(save) || save.version !== 1) return null;
    return save.round === key && isTeam(save.team) ? save.team : null;
  }

  const api = {
    UNITS_PER_PERCENT,
    PULL_UNITS,
    MEGA_UNITS,
    EXPECTED_PULL_UNITS,
    EXPECTED_MEGA_UNITS,
    MEGA_HOLD_MS,
    MEGA_COOLDOWN_MS,
    WIN_PERCENT,
    WIN_LEAD,
    TEAMS,
    weekStart,
    weekEnd,
    weekKey,
    isTeam,
    otherTeam,
    roundKey,
    counterName,
    pullUnits,
    unitsBetween,
    createTally,
    redPercent,
    winner,
    teamForTicket,
    unitsToWin,
    formatUnits,
    parseTeamCookie,
    teamFromSave,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TugCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
