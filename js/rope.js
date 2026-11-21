/*
 * The rope, kept in public retrac.space counters (see core.js for the rules).
 *
 *   - Finding the round: rounds are numbered from 0 each week. Starting from the last round
 *     this browser knew about, it reads each round's pulls and win markers until it reaches
 *     one nobody has won yet. That's the round everyone is pulling in.
 *   - Watching: while the tab is visible it reads both teams' pulls every few seconds, and
 *     the win markers every few reads, so wins seen elsewhere are picked up too.
 *   - Pulling: a pull shows on the rope at once, and is sent as one increment. Only a few
 *     are in flight at a time, and pulls faster than a person can click are not counted.
 *
 * Counts only ever go up, so the largest value seen for a counter is always the newest.
 */
(function () {
  'use strict';

  const core = window.TugCore;
  const API = 'https://space-api.retrac-space.workers.dev/v1/counters';
  const REQUEST_TIMEOUT_MS = 8000;
  const POLL_VISIBLE_MS = 2500;
  const POLL_HIDDEN_MS = 20000;
  const RETRY_MS = [3000, 6000, 12000, 30000];
  const MARKERS_EVERY = 4; // Read the win markers on every fourth poll.
  const MAX_PULLS_PER_SECOND = 8;
  const MAX_IN_FLIGHT = 3;
  const MAX_QUEUED = 24;
  const MAX_ROUNDS_SCANNED = 400;
  const CACHE_PREFIX = 'tugofwar:week:';

  const listeners = { change: new Set(), round: new Set(), win: new Set() };
  function emit(type, value) {
    listeners[type].forEach((listener) => {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    });
  }

  // status: loading (finding the round), live, or offline (the last reads failed).
  let status = 'loading';
  let week = null;
  let round = null; // null while the round is being found.
  let confirmed = { red: 0, blue: 0 };
  let wins = []; // wins[round] is the team that won that round this week.
  const pending = { red: 0, blue: 0 }; // Pulls from this tab not yet counted by the API.
  const mine = { red: 0, blue: 0 }; // Pulls from this tab the API has counted this round.
  const markersSent = new Set();

  // Bumped whenever the round or week changes, so late answers for an old round are ignored.
  let generation = 0;
  let pollTimer = null;
  let polling = false;
  let polls = 0;
  let failures = 0;
  const queue = [];
  let inFlight = 0;
  const recentPulls = [];

  async function call(op, name) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(API + '/' + op + '/' + encodeURIComponent(name), {
        method: op === 'increment' ? 'POST' : 'GET',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Counter request failed: ' + response.status);
      const body = await response.json();
      if (!body || !Number.isSafeInteger(body.count) || body.count < 0) throw new Error('Unexpected counter');
      return body.count;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readRound(forWeek, forRound, withMarkers) {
    const names = ['red', 'blue'].concat(withMarkers ? ['wonred', 'wonblue'] : []);
    const values = await Promise.all(names.map((kind) => call('get', core.counterName(forWeek, forRound, kind))));
    return { red: values[0], blue: values[1], wonRed: values[2] || 0, wonBlue: values[3] || 0, markers: withMarkers };
  }

  // ---------- This browser's memory of the week ----------

  function loadCache(forWeek) {
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_PREFIX + forWeek));
      if (saved && Number.isSafeInteger(saved.round) && saved.round >= 0 && Array.isArray(saved.wins)) {
        return { round: saved.round, wins: saved.wins.map((team) => (core.isTeam(team) ? team : null)) };
      }
    } catch (error) {
      // Storage can be blocked or hold something old. Start from the first round.
    }
    return { round: 0, wins: [] };
  }

  function saveCache() {
    try {
      // Only this week matters, so older weeks are tidied away.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(CACHE_PREFIX) && key !== CACHE_PREFIX + week) localStorage.removeItem(key);
      }
      localStorage.setItem(CACHE_PREFIX + week, JSON.stringify({ round, wins }));
    } catch (error) {
      // Not essential: without it the next visit just checks from the first round.
    }
  }

  // ---------- Reading ----------

  function snapshot() {
    const red = confirmed.red + pending.red;
    const blue = confirmed.blue + pending.blue;
    return {
      status,
      week,
      round,
      key: week && round !== null ? core.roundKey(week, round) : null,
      red,
      blue,
      confirmed: { ...confirmed },
      mine: { red: mine.red + pending.red, blue: mine.blue + pending.blue },
      counted: { ...mine },
      redPercent: core.redPercent(red, blue),
      toWin: core.pullsToWin(red, blue),
      wins: wins.slice(),
      endsAt: core.weekEnd(Date.now()),
    };
  }

  function setStatus(next) {
    if (status === next) return;
    status = next;
    emit('change', snapshot());
  }

  function markWin(forWeek, forRound, team) {
    const key = core.roundKey(forWeek, forRound);
    if (markersSent.has(key)) return;
    markersSent.add(key);
    call('increment', core.counterName(forWeek, forRound, 'won' + team)).catch(() => {
      markersSent.delete(key); // Someone else will very likely mark it, or this tab will next time.
    });
  }

  // Walks forward from the last round this browser knew to the first unfinished one.
  async function findRound(forWeek) {
    const cache = loadCache(forWeek);
    const seenWins = cache.wins.slice();
    for (let r = cache.round; r < cache.round + MAX_ROUNDS_SCANNED; r++) {
      const counts = await readRound(forWeek, r, true);
      const team = core.winner(counts);
      if (!team) return { round: r, counts, wins: seenWins };
      seenWins[r] = team;
      if (!counts.wonRed && !counts.wonBlue) markWin(forWeek, r, team);
    }
    throw new Error('Too many rounds');
  }

  function enterRound(forWeek, found) {
    const isNew = forWeek !== week || found.round !== round;
    if (isNew) {
      generation++;
      queue.length = 0;
      pending.red = pending.blue = 0;
      mine.red = mine.blue = 0;
      confirmed = { red: 0, blue: 0 };
    }
    week = forWeek;
    round = found.round;
    wins = found.wins;
    confirmed = {
      red: Math.max(confirmed.red, found.counts.red),
      blue: Math.max(confirmed.blue, found.counts.blue),
    };
    status = 'live';
    saveCache();
    if (isNew) emit('round', snapshot());
    emit('change', snapshot());
  }

  // A win ends the round here, then the next round is found the usual way, in case others
  // have already moved on (or won that one too).
  function finishRound(team, fromMarker) {
    const forWeek = week;
    const forRound = round;
    if (!fromMarker) markWin(forWeek, forRound, team);
    wins[forRound] = team;
    round = forRound + 1;
    saveCache();
    generation++;
    queue.length = 0;
    pending.red = pending.blue = 0;
    const final = snapshot();
    emit('win', { week: forWeek, round: forRound, team, red: confirmed.red, blue: confirmed.blue, wins: final.wins });
    round = null;
    confirmed = { red: 0, blue: 0 };
    mine.red = mine.blue = 0;
    schedule(0);
  }

  function evaluate(markers) {
    const team = core.winner({
      red: confirmed.red,
      blue: confirmed.blue,
      wonRed: markers ? markers.wonRed : 0,
      wonBlue: markers ? markers.wonBlue : 0,
    });
    if (!team) return false;
    finishRound(team, Boolean(markers && (markers.wonRed || markers.wonBlue)));
    return true;
  }

  async function tick() {
    if (polling) return;
    polling = true;
    const started = generation;
    try {
      const now = core.weekKey(Date.now());
      if (now !== week || round === null) {
        // A new week, or a round to find: everything starts from what the counters say.
        if (now !== week) {
          generation++;
          round = null;
          setStatus('loading');
        }
        const found = await findRound(now);
        if (core.weekKey(Date.now()) === now) enterRound(now, found);
      } else {
        polls++;
        const counts = await readRound(week, round, polls % MARKERS_EVERY === 0);
        if (started === generation) {
          confirmed = { red: Math.max(confirmed.red, counts.red), blue: Math.max(confirmed.blue, counts.blue) };
          status = 'live';
          if (!evaluate(counts.markers ? counts : null)) emit('change', snapshot());
        }
      }
      failures = 0;
    } catch (error) {
      failures++;
      if (failures >= 2) setStatus('offline');
    } finally {
      polling = false;
      // Straight on to the next round after a win seen here.
      schedule(round === null && !failures ? 0 : undefined);
    }
  }

  function schedule(delay) {
    clearTimeout(pollTimer);
    let wait = delay;
    if (wait === undefined) {
      if (failures) wait = RETRY_MS[Math.min(failures, RETRY_MS.length) - 1];
      else wait = document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
    }
    pollTimer = setTimeout(tick, wait);
  }

  // ---------- Pulling ----------

  function pump() {
    while (inFlight < MAX_IN_FLIGHT && queue.length) {
      const job = queue.shift();
      inFlight++;
      call('increment', core.counterName(job.week, job.round, job.team))
        .then((value) => {
          if (job.generation !== generation) return;
          failures = 0;
          status = 'live';
          confirmed[job.team] = Math.max(confirmed[job.team], value);
          mine[job.team]++;
        })
        .catch(() => {
          // A lost pull is just a lost pull. Reads keep deciding whether we're offline.
        })
        .finally(() => {
          inFlight--;
          if (job.generation === generation) {
            pending[job.team] = Math.max(0, pending[job.team] - 1);
            if (!evaluate(null)) emit('change', snapshot());
          }
          pump();
        });
    }
  }

  // Returns true when the pull counts, false when it was too fast or there's no round yet.
  function pull(team) {
    if (!core.isTeam(team) || round === null || status === 'loading') return false;
    const now = performance.now();
    while (recentPulls.length && now - recentPulls[0] >= 1000) recentPulls.shift();
    if (recentPulls.length >= MAX_PULLS_PER_SECOND || queue.length >= MAX_QUEUED) return false;
    recentPulls.push(now);
    pending[team]++;
    queue.push({ team, week, round, generation });
    pump();
    emit('change', snapshot());
    return true;
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') schedule(0);
    });
    window.addEventListener('online', () => schedule(0));
    tick();
  }

  window.TugRope = {
    start,
    pull,
    snapshot,
    on(type, listener) {
      listeners[type].add(listener);
      return () => listeners[type].delete(listener);
    },
  };
})();
