/*
 * Who's here, using the public retrac.space presence API.
 *
 * Presence only knows names, not teams, so each side is its own presence site:
 * "tugofwar-red" and "tugofwar-blue". Heartbeats start once you've been given a team, and
 * when the round ends you leave that site until your next team comes along.
 *
 * One visitor per browser session: every tab shares the same visitor ID through a session
 * cookie, like Simple Soundboard. Signed-in visitors show their username; everyone else gets
 * an anonymous animal from the API. The API forgets anyone it hasn't heard from in 90 seconds.
 */
(function () {
  'use strict';

  const API = 'https://space-api.retrac-space.workers.dev/v1/presence';
  const PREFIX = 'tugofwar-';
  const VISITOR_COOKIE = 'tugofwar-visitor';
  const VISIBLE_KEY = 'tugofwar:visible-tab';
  const HEARTBEAT_MS = 30000;
  const LIST_VISIBLE_MS = 5000;
  const LIST_HIDDEN_MS = 30000;
  const REQUEST_TIMEOUT_MS = 8000;
  // crypto.randomUUID only exists on secure (https) pages. Over plain http it's missing, so
  // build the same kind of random v4 UUID from crypto.getRandomValues, which works anywhere.
  function uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4.
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant.
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
      + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  const tabId = uuid();

  let visitorId = readVisitor() || uuid();
  let username = null;
  let accountReady = false;
  let team = null;
  let site = null; // No team, no heartbeats.
  let displayName = null;
  let heartbeatTimer = null;
  let listTimer = null;
  let heartbeatInFlight = null;
  let listInFlight = false;
  let state = { status: 'checking', red: [], blue: [], self: null, team: null };
  const listeners = new Set();

  function publish(next) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener(state));
  }

  function readVisitor() {
    const prefix = VISITOR_COOKIE + '=';
    const entry = document.cookie.split(/;\s*/).find((part) => part.startsWith(prefix));
    const value = entry && entry.slice(prefix.length);
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  }

  // No Max-Age: a session cookie, so a new browser session is a new visitor.
  function writeVisitor() {
    try {
      document.cookie = VISITOR_COOKIE + '=' + visitorId + '; Path=/; SameSite=Lax'
        + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (error) {
      // Blocked cookies fall back to this tab's own ID.
    }
  }
  writeVisitor();

  function siteFor(value) {
    return value ? PREFIX + value : null;
  }

  async function send(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal, ...options });
      if (!response.ok) throw new Error('Presence request failed: ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------- Tabs ----------

  // A hidden tab stays quiet while another tab is on screen, so it can't mark you idle.
  function stampVisible() {
    if (document.visibilityState !== 'visible') return;
    try {
      localStorage.setItem(VISIBLE_KEY, JSON.stringify({ tab: tabId, at: Date.now() }));
    } catch (error) { /* Without storage, each tab speaks for itself. */ }
  }

  function anotherTabVisible() {
    try {
      const stamp = JSON.parse(localStorage.getItem(VISIBLE_KEY));
      return Boolean(stamp && stamp.tab !== tabId && Date.now() - stamp.at < 15000);
    } catch (error) {
      return false;
    }
  }

  // ---------- Heartbeats ----------

  function heartbeat() {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(heartbeat, HEARTBEAT_MS);
    if (!accountReady || !site) return Promise.resolve();
    const visible = document.visibilityState === 'visible';
    if (!visible && anotherTabVisible()) return Promise.resolve();
    stampVisible();
    const target = site;
    const current = readVisitor();
    if (current && current !== visitorId) visitorId = current;
    writeVisitor();
    const body = { visitorId, status: visible ? 'online' : 'idle' };
    // Display names are unverified. Never send account tokens here.
    if (username) body.username = username;
    const request = send(API + '/heartbeat/' + target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((response) => {
      if (target !== site || !response || typeof response.displayName !== 'string') return;
      displayName = response.displayName;
      publish({ self: displayName });
    }).catch(() => {
      // The next heartbeat tries again. The rope works without presence.
    });
    heartbeatInFlight = request;
    return request;
  }

  function leave(target) {
    send(API + '/leave/' + target, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId }),
    }).catch(() => {
      // Not essential: the old site forgets this visitor after 90 seconds anyway.
    });
  }

  // ---------- Who's online ----------

  function validList(body) {
    return body && Number.isSafeInteger(body.count) && body.count >= 0 && Array.isArray(body.users)
      && body.users.every((user) => user && typeof user.displayName === 'string' && user.displayName.trim()
        && (user.status === undefined || user.status === 'online' || user.status === 'idle'));
  }

  // One figure per person: a username open on several devices is merged (online wins), but
  // anonymous animals never are, since two strangers can share one.
  function people(users) {
    const named = new Map();
    const result = [];
    users.forEach((user) => {
      const name = user.displayName.trim();
      const status = user.status || 'online';
      const anonymous = name.startsWith('Anonymous ');
      if (!anonymous) {
        const existing = named.get(name.toLowerCase());
        if (existing) {
          if (status === 'online') existing.status = 'online';
          return;
        }
      }
      const person = { name, status, anonymous };
      if (!anonymous) named.set(name.toLowerCase(), person);
      result.push(person);
    });
    return result;
  }

  async function refreshLists() {
    clearTimeout(listTimer);
    listTimer = setTimeout(refreshLists, document.visibilityState === 'visible' ? LIST_VISIBLE_MS : LIST_HIDDEN_MS);
    if (listInFlight || !accountReady) return;
    listInFlight = true;
    stampVisible();
    try {
      if (heartbeatInFlight) await heartbeatInFlight;
      const [red, blue] = await Promise.all([siteFor('red'), siteFor('blue')]
        .map((target) => send(API + '/online/' + target, { method: 'GET' })));
      if (!validList(red) || !validList(blue)) throw new Error('Unexpected presence');
      publish({ status: 'online', red: people(red.users), blue: people(blue.users), team });
    } catch (error) {
      publish({ status: 'unavailable' });
    } finally {
      listInFlight = false;
    }
  }

  // ---------- Changes ----------

  function setTeam(value) {
    const next = siteFor(value);
    if (next === site) return;
    const previous = site;
    site = next;
    team = value || null;
    displayName = null;
    publish({ team, self: null });
    if (previous) leave(previous);
    heartbeat().then(refreshLists);
  }

  function setUsername(value) {
    if (accountReady && value === username) return;
    // The API keeps a supplied name even when it's left out later, so signing out needs a
    // fresh visitor to get an anonymous animal again.
    if (username && !value) {
      if (site) leave(site);
      visitorId = uuid();
    }
    username = value;
    accountReady = true;
    writeVisitor();
    heartbeat().then(refreshLists);
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    document.addEventListener('visibilitychange', () => {
      heartbeat();
      if (document.visibilityState === 'visible') refreshLists();
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) heartbeat().then(refreshLists);
    });
    window.RetracAccount.subscribe((account) => {
      if (account.status === 'unknown') return;
      setUsername(account.status === 'authenticated' ? account.username : null);
    });
    // Don't wait forever for the account check: guests heartbeat anonymously.
    setTimeout(() => {
      if (!accountReady) setUsername(null);
    }, 6000);
    refreshLists();
  }

  window.TugPresence = {
    start,
    setTeam,
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
