/*
 * The rope, kept in public retrac.space counters (see core.js for the rules).
 *
 *   - Finding the round: rounds are numbered from 0 each week. Starting from the last round
 *     this browser knew about, it reads each round's pulls and win markers until it reaches
 *     one nobody has won yet. That's the round everyone is pulling in.
 *   - Watching: while the tab is visible it reads every pull counter every few seconds, and
 *     the win markers every few reads, so wins seen elsewhere are picked up too.
 *   - Pulling: a pull shows on the rope at once (at an average strength), and is sent as one
 *     increment. The number the API hands back says exactly how strong it was. Only a few are
 *     in flight at a time, and pulls faster than a person can click are not counted.
 *   - Mega pulls work the same way on their own counters, once per cooldown.
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
  const MEGA_KEY = 'tugofwar:mega-at';
  const KINDS = ['red', 'blue', 'redmega', 'bluemega'];

  const listeners = { change: new Set(), round: new Set(), win: new Set(), pulled: new Set() };
  function emit(type, value) {
    listeners[type].forEach((listener) => {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    });
  }

  const zero = () => ({ red: 0, blue: 0, redmega: 0, bluemega: 0 });
  const tally = core.createTally();

  // status: loading (finding the round), live, or offline (the last reads failed).
  let status = 'loading';
  let week = null;
  let round = null; // null while the round is being found.
  let confirmed = zero(); // Pulls counted so far on each counter.
  let wins = []; // wins[round] is the team that won that round this week.
  const pending = zero(); // Pulls from this tab not yet counted by the API.
  const mine = zero(); // Pulls from this tab the API has counted this round.
  const mineUnits = { red: 0, blue: 0 };
  const markersSent = new Set();
  let lastMega = readLastMega();

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
    const kinds = KINDS.concat(withMarkers ? ['wonred', 'wonblue'] : []);
    const values = await Promise.all(kinds.map((kind) => call('get', core.counterName(forWeek, forRound, kind))));
    const counts = { markers: withMarkers, wonRed: 0, wonBlue: 0 };
    kinds.forEach((kind, i) => {
      counts[kind === 'wonred' ? 'wonRed' : kind === 'wonblue' ? 'wonBlue' : kind] = values[i];
    });
    return counts;
  }

  // A team's total strength, in units, from the pulls counted so far.
  function teamUnits(forWeek, forRound, counts, team) {
    return tally(core.counterName(forWeek, forRound, team), counts[team])
      + tally(core.counterName(forWeek, forRound, team + 'mega'), counts[team + 'mega']);
  }

  function totals(forWeek, forRound, counts) {
    return { red: teamUnits(forWeek, forRound, counts, 'red'), blue: teamUnits(forWeek, forRound, counts, 'blue') };
  }

  // ---------- This browser's memory ----------

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

  // The cooldown survives a reload, so reloading isn't a shortcut to another mega pull.
  function readLastMega() {
    try {
      const value = Number(localStorage.getItem(MEGA_KEY));
      return Number.isFinite(value) && value <= Date.now() ? value : 0;
    } catch (error) {
      return 0;
    }
  }

  function writeLastMega() {
    try {
      localStorage.setItem(MEGA_KEY, String(lastMega));
    } catch (error) { /* Only this tab remembers, then. */ }
  }

  // ---------- Reading ----------

  function snapshot() {
    const counted = week && round !== null ? totals(week, round, confirmed) : { red: 0, blue: 0 };
    const red = counted.red + pending.red * core.EXPECTED_PULL_UNITS + pending.redmega * core.EXPECTED_MEGA_UNITS;
    const blue = counted.blue + pending.blue * core.EXPECTED_PULL_UNITS + pending.bluemega * core.EXPECTED_MEGA_UNITS;
    return {
      status,
      week,
      round,
      key: week && round !== null ? core.roundKey(week, round) : null,
      red, // Each team's strength in units, including this tab's pulls on their way.
      blue,
      confirmed: { ...confirmed }, // Pulls counted on each counter.
      counted: { ...mine }, // This tab's pulls the API has counted, per counter.
      mine: {
        red: mine.red + mine.redmega + pending.red + pending.redmega,
        blue: mine.blue + mine.bluemega + pending.blue + pending.bluemega,
      },
      mineUnits: { ...mineUnits },
      redPercent: core.redPercent(red, blue),
      toWin: core.unitsToWin(red, blue),
      wins: wins.slice(),
      endsAt: core.weekEnd(Date.now()),
      megaReadyAt: lastMega ? lastMega + core.MEGA_COOLDOWN_MS : 0,
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
      const team = core.winner({ ...totals(forWeek, r, counts), wonRed: counts.wonRed, wonBlue: counts.wonBlue });
      if (!team) return { round: r, counts, wins: seenWins };
      seenWins[r] = team;
      if (!counts.wonRed && !counts.wonBlue) markWin(forWeek, r, team);
    }
    throw new Error('Too many rounds');
  }

  function resetRoundState() {
    generation++;
    queue.length = 0;
    confirmed = zero();
    KINDS.forEach((kind) => {
      pending[kind] = 0;
      mine[kind] = 0;
    });
    mineUnits.red = mineUnits.blue = 0;
  }

  function takeCounts(counts) {
    KINDS.forEach((kind) => {
      confirmed[kind] = Math.max(confirmed[kind], counts[kind] || 0);
    });
  }

  function enterRound(forWeek, found) {
    const isNew = forWeek !== week || found.round !== round;
    if (isNew) resetRoundState();
    week = forWeek;
    round = found.round;
    wins = found.wins;
    takeCounts(found.counts);
    status = 'live';
    saveCache();
    if (isNew) emit('round', snapshot());
    emit('change', snapshot());
  }

  // A win ends the round here, then the next round is found the usual way, in case others
  // have already moved on (or won that one too).
  function finishRound(team, fromMarker, final) {
    const forWeek = week;
    const forRound = round;
    if (!fromMarker) markWin(forWeek, forRound, team);
    wins[forRound] = team;
    round = forRound + 1;
    saveCache();
    emit('win', { week: forWeek, round: forRound, team, red: final.red, blue: final.blue, wins: wins.slice() });
    resetRoundState();
    round = null;
    schedule(0);
  }

  function evaluate(markers) {
    const now = totals(week, round, confirmed);
    const team = core.winner({
      ...now,
      wonRed: markers ? markers.wonRed : 0,
      wonBlue: markers ? markers.wonBlue : 0,
    });
    if (!team) return false;
    finishRound(team, Boolean(markers && (markers.wonRed || markers.wonBlue)), now);
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
          takeCounts(counts);
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
      const name = core.counterName(job.week, job.round, job.kind);
      inFlight++;
      call('increment', name)
        .then((number) => {
          if (job.generation !== generation) return;
          failures = 0;
          status = 'live';
          confirmed[job.kind] = Math.max(confirmed[job.kind], number);
          mine[job.kind]++;
          // The number this pull got decides how strong it was.
          const units = core.pullUnits(name, number);
          mineUnits[job.team] += units;
          emit('pulled', { team: job.team, mega: job.mega, units, meta: job.meta });
        })
        .catch(() => {
          // A lost pull is just a lost pull. Reads keep deciding whether we're offline.
        })
        .finally(() => {
          inFlight--;
          if (job.generation === generation) {
            pending[job.kind] = Math.max(0, pending[job.kind] - 1);
            if (!evaluate(null)) emit('change', snapshot());
          }
          pump();
        });
    }
  }

  function send(team, mega, meta) {
    const kind = mega ? team + 'mega' : team;
    pending[kind]++;
    queue.push({ kind, team, mega, meta, week, round, generation });
    pump();
    emit('change', snapshot());
  }

  function canPull(team) {
    return core.isTeam(team) && round !== null && status !== 'loading' && queue.length < MAX_QUEUED;
  }

  // An ordinary pull. Returns true when it counts, false when it was too fast or there's no
  // round yet. `meta` comes back with the "pulled" event (the page uses it for where to
  // show the strength).
  function pull(team, meta) {
    if (!canPull(team)) return false;
    const now = performance.now();
    while (recentPulls.length && now - recentPulls[0] >= 1000) recentPulls.shift();
    if (recentPulls.length >= MAX_PULLS_PER_SECOND) return false;
    recentPulls.push(now);
    send(team, false, meta);
    return true;
  }

  function megaReady() {
    return Date.now() >= lastMega + core.MEGA_COOLDOWN_MS;
  }

  // A mega pull, once per cooldown.
  function megaPull(team, meta) {
    if (!canPull(team) || !megaReady()) return false;
    lastMega = Date.now();
    writeLastMega();
    send(team, true, meta);
    return true;
  }

  // Takes the next team ticket for the current round. Resolves to { key, team }.
  async function ticket() {
    if (round === null) throw new Error('No round yet');
    const forWeek = week;
    const forRound = round;
    const number = await call('increment', core.counterName(forWeek, forRound, 'joins'));
    return { key: core.roundKey(forWeek, forRound), team: core.teamForTicket(number, forRound) };
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
    megaPull,
    megaReady,
    ticket,
    snapshot,
    on(type, listener) {
      listeners[type].add(listener);
      return () => listeners[type].delete(listener);
    },
  };
})();
