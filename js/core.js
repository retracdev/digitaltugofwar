/*
 * The rules of the rope, kept free of the page so they can be tested in Node.
 *
 * Every pull is one increment of a public retrac.space counter, one counter per team per
 * round: tugofwar-<week>-r<round>-red and tugofwar-<week>-r<round>-blue. Counters can only
 * go up and can't be reset, so a fresh round or week simply uses fresh counter names.
 *
 * The rope sits at 50% and moves PULL_WORTH percentage points toward a team for every pull
 * that team is ahead by. A team wins the round when the rope reaches WIN_PERCENT on its
 * side, which takes a lead of WIN_LEAD pulls. Rounds also end when the week ends (Monday
 * 00:00 UTC), because the week is part of every counter name.
 *
 * The lead can shrink again after a win if pulls were still on their way, so the first
 * visitor to see a win also increments a "won" marker counter for that round. A marker
 * that's above zero settles the round for good, whatever the pulls say later.
 */
(function (root) {
  'use strict';

  const PULLS_PER_PERCENT = 20; // Each pull is worth 1/20 of a percent, so 0.05%.
  const PULL_WORTH = 1 / PULLS_PER_PERCENT;
  const WIN_PERCENT = 95;
  const WIN_LEAD = (WIN_PERCENT - 50) * PULLS_PER_PERCENT; // 900 pulls ahead.
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

  // kind is a team ("red", "blue"), that team's win marker ("wonred", "wonblue"), or the
  // round's team tickets ("joins").
  function counterName(week, round, kind) {
    return PREFIX + '-' + week + '-r' + round + '-' + kind;
  }

  function count(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  // How far Red has the rope, from 5 to 95. Blue has the rest.
  function redPercent(red, blue) {
    const percent = 50 + (count(red) - count(blue)) / PULLS_PER_PERCENT;
    return Math.min(WIN_PERCENT, Math.max(100 - WIN_PERCENT, percent));
  }

  // The team that has won this round, or null while it's still going.
  function winner(counts) {
    const red = count(counts.red);
    const blue = count(counts.blue);
    const wonRed = count(counts.wonRed) > 0;
    const wonBlue = count(counts.wonBlue) > 0;
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

  // How many more pulls the leading team needs, or null when it's even.
  function pullsToWin(red, blue) {
    const lead = count(red) - count(blue);
    if (lead === 0) return null;
    return { team: lead > 0 ? 'red' : 'blue', pulls: Math.max(0, WIN_LEAD - Math.abs(lead)) };
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
    PULL_WORTH,
    PULLS_PER_PERCENT,
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
    redPercent,
    winner,
    teamForTicket,
    pullsToWin,
    parseTeamCookie,
    teamFromSave,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TugCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
