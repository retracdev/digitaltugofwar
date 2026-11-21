/*
 * Which side you're on this round. Nobody picks: app.js assigns a team (see
 * core.teamForTicket) once this file is "settled", meaning it knows you don't already have one.
 *
 * Everyone's team is kept in a cookie as "<round key>.<team>", so it's forgotten as soon as
 * the round ends (a win or a new week). Signed-in visitors also keep it in their retrac.space
 * cloud save (game "tugofwar", slot 0) as { version: 1, round, team, joinedAt }, so they're
 * on the same side on every device. The account wins any disagreement: the cookie just
 * follows it.
 *
 * Cloud saving is a bonus. If it can't be reached, the cookie still works.
 */
(function () {
  'use strict';

  const core = window.TugCore;
  const account = window.RetracAccount;
  const SAVE_URL = 'https://space-api.retrac-space.workers.dev/v1/games/tugofwar/saves/0';
  const COOKIE = 'tugofwar-team';
  const COOKIE_MAX_AGE = 8 * 86400; // A round never outlives its week.
  const REQUEST_TIMEOUT_MS = 8000;
  const RETRY_MS = 15000;
  const MAX_RETRY_MS = 300000;

  let key = null; // The current round's key, or null while the round is being found.
  let team = null;
  let username = null;
  let accountKnown = false; // Whether the first account check has answered.
  // cloud: off (not signed in), syncing, saved, or unavailable (cookie only for now).
  let cloud = 'off';
  let chain = Promise.resolve();
  let retryTimer = null;
  let retries = 0;
  const listeners = new Set();

  // Settled: there's a round, and if you have a team for it, `team` already says so. Signed-in
  // visitors aren't settled until their cloud save has been read (or couldn't be).
  function get() {
    const settled = Boolean(key) && accountKnown && (!username || cloud === 'saved' || cloud === 'unavailable');
    return { key, team, cloud, username, settled };
  }

  function publish() {
    const state = get();
    listeners.forEach((listener) => listener(state));
  }

  function readCookie(forKey) {
    return core.parseTeamCookie(document.cookie, COOKIE, forKey);
  }

  function writeCookie(forKey, value) {
    try {
      document.cookie = COOKIE + '=' + encodeURIComponent(forKey + '.' + value)
        + '; Max-Age=' + COOKIE_MAX_AGE + '; Path=/; SameSite=Lax'
        + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (error) {
      // Blocked cookies just mean the team is remembered for this page only.
    }
  }

  async function request(token, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(SAVE_URL, {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
        ...options,
        headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) },
      });
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body && body.error && body.error.code;
      throw Object.assign(new Error(code || 'save_failed'), { status: response.status, code });
    }
    return body;
  }

  // Resolves to the saved data, or null when this account has no save yet.
  async function readSave(token) {
    try {
      const body = await request(token, { method: 'GET' });
      return body && body.data ? body.data.data : null;
    } catch (error) {
      if (error.status === 404 && error.code === 'save_not_found') return null;
      throw error;
    }
  }

  function writeSave(token, forKey, value) {
    return request(token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { version: 1, round: forKey, team: value, joinedAt: Date.now() } }),
    });
  }

  function setCloud(next) {
    if (cloud === next) return;
    cloud = next;
    publish();
  }

  // Brings the cookie and the account into line for the current round. One at a time, so
  // a team assigned while syncing is written after the read that came before it.
  function sync() {
    clearTimeout(retryTimer);
    const forKey = key;
    const forUser = username;
    if (!forKey || !forUser) return chain;
    setCloud('syncing');
    chain = chain.then(async () => {
      if (forKey !== key || forUser !== username) return;
      try {
        const { token } = await account.fetchToken();
        const saved = core.teamFromSave(await readSave(token), forKey);
        if (forKey !== key || forUser !== username) return;
        if (saved) {
          if (saved !== team) {
            team = saved;
            writeCookie(forKey, saved);
          }
        } else if (team) {
          await writeSave(token, forKey, team);
        }
        retries = 0;
        if (forKey === key && forUser === username) cloud = 'saved';
        publish();
      } catch (error) {
        if (forKey !== key || forUser !== username) return;
        setCloud('unavailable');
        // Unknown game, expired session, outage: the cookie carries on, and this tries again,
        // waiting longer each time.
        retryTimer = setTimeout(sync, Math.min(RETRY_MS * 2 ** retries, MAX_RETRY_MS));
        retries++;
      }
    });
    return chain;
  }

  function setRound(nextKey) {
    if (nextKey === key) return;
    key = nextKey;
    team = nextKey ? readCookie(nextKey) : null;
    // Not settled until the account has been asked about this round too.
    if (username && nextKey) cloud = 'syncing';
    publish();
    if (username) sync();
  }

  // Another tab may have been given a team since this one loaded.
  function recheck() {
    if (!key || team) return;
    const fromCookie = readCookie(key);
    if (fromCookie) {
      team = fromCookie;
      publish();
    }
  }

  // Puts you on a team for the round `forKey`. Does nothing if you already have one.
  function assign(forKey, value) {
    if (!key || forKey !== key || !core.isTeam(value)) return false;
    recheck();
    if (team) return false;
    team = value;
    writeCookie(key, value);
    publish();
    if (username) sync();
    return true;
  }

  account.subscribe((state) => {
    if (state.status === 'unknown') return;
    const firstAnswer = !accountKnown;
    accountKnown = true;
    const next = state.status === 'authenticated' ? state.username : null;
    // A failed recheck isn't a sign-out (account.js keeps the old state for that).
    if (next === username) {
      if (firstAnswer) publish();
      return;
    }
    username = next;
    retries = 0;
    clearTimeout(retryTimer);
    cloud = username && key ? 'syncing' : 'off';
    publish();
    if (username) sync();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheck();
  });

  window.TugTeam = {
    get,
    setRound,
    assign,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
