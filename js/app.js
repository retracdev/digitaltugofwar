/*
 * Digital Tug of War: wires the rope, your team, who's online and the stage together.
 */
(function () {
  'use strict';

  const core = window.TugCore;
  const account = window.RetracAccount;
  const rope = window.TugRope;
  const teams = window.TugTeam;
  const presence = window.TugPresence;
  const stage = window.TugStage;
  const signIn = window.TugSignIn;

  const $ = (id) => document.getElementById(id);
  const el = {
    connection: $('connection'),
    connectionLabel: $('connectionLabel'),
    accountButton: $('accountButton'),
    redPct: $('redPct'),
    bluePct: $('bluePct'),
    redMeta: $('redMeta'),
    blueMeta: $('blueMeta'),
    bar: $('bar'),
    barRed: $('barRed'),
    scoreStatus: $('scoreStatus'),
    round: $('roundLabel'),
    tally: $('tally'),
    reset: $('resetLabel'),
    arena: $('arena'),
    halves: { red: $('halfRed'), blue: $('halfBlue') },
    dockJoin: $('dockJoin'),
    dockPlay: $('dockPlay'),
    dockTeam: $('dockTeam'),
    dockCount: $('dockCount'),
    saveNote: $('saveNote'),
    celebrate: $('celebrate'),
    toasts: $('toasts'),
  };

  const TEAM_NAMES = { red: 'Team Red', blue: 'Team Blue' };
  const MINE_PREFIX = 'tugofwar:mine:';
  let myTeam = null;
  let roundKey = null;
  let currentWeek = null;
  let last = null; // The previous rope snapshot, to spot pulls from everyone else.
  let myPulls = 0;
  let savedPulls = 0; // Pulls from earlier visits this round, from this browser.

  // ---------- Formatting ----------

  function percent(value) {
    return value.toFixed(1) + '%';
  }

  function plural(count, one, many) {
    return count.toLocaleString() + ' ' + (count === 1 ? one : many);
  }

  function untilReset(endsAt) {
    const minutes = Math.max(0, Math.ceil((endsAt - Date.now()) / 60000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days) return days + 'd ' + hours + 'h';
    if (hours) return hours + 'h ' + (minutes % 60) + 'm';
    return Math.max(1, minutes) + 'm';
  }

  // ---------- Toasts ----------

  function toast(text, team) {
    if (document.visibilityState !== 'visible') return;
    while (el.toasts.children.length >= 3) el.toasts.firstElementChild.remove();
    const item = document.createElement('div');
    item.className = 'toast' + (team ? ' toast--' + team : '');
    item.textContent = text;
    el.toasts.append(item);
    setTimeout(() => item.classList.add('toast--leaving'), 3600);
    setTimeout(() => item.remove(), 4000);
  }

  // ---------- Your pulls this round ----------

  function loadMine(key) {
    try {
      const value = Number(localStorage.getItem(MINE_PREFIX + key));
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch (error) {
      return 0;
    }
  }

  function saveMine() {
    if (!roundKey) return;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(MINE_PREFIX) && key !== MINE_PREFIX + roundKey) localStorage.removeItem(key);
      }
      localStorage.setItem(MINE_PREFIX + roundKey, String(savedPulls + myPulls));
    } catch (error) { /* Only a nicety. */ }
  }

  // ---------- The scoreboard ----------

  function renderRope(snap) {
    const red = snap.redPercent;
    // Rounded once, so the two sides always add up to exactly 100%.
    const shown = Math.round(red * 10) / 10;
    el.redPct.textContent = percent(shown);
    el.bluePct.textContent = percent(100 - shown);
    el.barRed.style.width = red + '%';
    el.bar.setAttribute('aria-valuenow', red.toFixed(1));
    el.bar.setAttribute('aria-valuetext', 'Red ' + percent(shown) + ', Blue ' + percent(100 - shown));
    stage.setPosition(red);

    if (snap.status === 'loading' || snap.round === null) {
      el.scoreStatus.textContent = 'Finding the rope…';
    } else if (snap.status === 'offline') {
      el.scoreStatus.textContent = 'Can’t reach the rope right now. Trying again…';
    } else if (!snap.toWin) {
      el.scoreStatus.textContent = 'Dead even. Every pull counts.';
    } else {
      el.scoreStatus.textContent = TEAM_NAMES[snap.toWin.team] + ' is ahead · '
        + plural(snap.toWin.pulls, 'more pull', 'more pulls') + ' to win';
    }
    el.scoreStatus.dataset.team = snap.toWin ? snap.toWin.team : '';

    el.round.textContent = snap.round === null ? 'Round …' : 'Round ' + (snap.round + 1);
    const won = { red: 0, blue: 0 };
    snap.wins.forEach((team) => {
      if (team) won[team]++;
    });
    el.tally.textContent = won.red || won.blue
      ? 'This week: Red ' + won.red + ' · Blue ' + won.blue
      : 'No wins yet this week';
    el.reset.textContent = 'Resets in ' + untilReset(snap.endsAt);

    el.connection.dataset.state = snap.status;
    el.connectionLabel.textContent = snap.status === 'live' ? 'Live'
      : snap.status === 'offline' ? 'Reconnecting…' : 'Connecting…';

    // Pulls from everyone else make their side heave too.
    if (last && last.key === snap.key) {
      core.TEAMS.forEach((team) => {
        const theirs = (snap.confirmed[team] - last.confirmed[team]) - (snap.counted[team] - last.counted[team]);
        if (theirs > 0) stage.tug(team);
      });
    }
    if (myTeam && snap.key === roundKey) {
      myPulls = snap.mine[myTeam];
      el.dockCount.textContent = 'You’ve pulled ' + plural(savedPulls + myPulls, 'time', 'times') + ' this round.';
      if (!last || last.counted[myTeam] !== snap.counted[myTeam]) saveMine();
    }
    last = snap;
  }

  // ---------- Teams and people ----------

  function renderTeam(state) {
    const joined = Boolean(state.team);
    document.body.dataset.team = state.team || '';
    el.arena.classList.toggle('is-joined', joined);
    core.TEAMS.forEach((team) => {
      const half = el.halves[team];
      const mine = state.team === team;
      half.classList.toggle('half--mine', mine);
      half.classList.toggle('half--theirs', joined && !mine);
      half.setAttribute('aria-label', mine ? 'Pull for ' + TEAM_NAMES[team] : TEAM_NAMES[team]);
      half.tabIndex = mine ? 0 : -1;
      half.setAttribute('aria-disabled', mine ? 'false' : 'true');
    });
    el.dockJoin.hidden = joined || !state.key;
    el.dockPlay.hidden = !joined;
    if (joined) {
      el.dockTeam.textContent = 'You’re on ' + TEAM_NAMES[state.team];
      el.dockTeam.dataset.team = state.team;
    }

    const note = el.saveNote;
    note.replaceChildren();
    if (!state.key) return;
    if (state.cloud === 'off') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link-button';
      button.textContent = 'Sign in';
      button.addEventListener('click', () => openSignIn(button));
      note.append(joined ? 'Your team is saved in this browser. ' : 'Your team will be saved in this browser. ',
        button, ' to keep it on every device and put your name on the rope.');
    } else if (state.cloud === 'syncing') {
      note.append('Syncing your team with your retrac.space account…');
    } else if (state.cloud === 'saved') {
      note.append(joined ? 'Your team is saved to your retrac.space account.'
        : 'Your team will be saved to your retrac.space account.');
    } else {
      note.append('Saved in this browser. Couldn’t reach your retrac.space cloud save, trying again soon.');
    }
  }

  function byName(a, b) {
    if (a.anonymous !== b.anonymous) return a.anonymous ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  }

  function selfName() {
    const known = presence.get().self;
    if (known) return known;
    const state = account.getState();
    return state.status === 'authenticated' ? state.username : null;
  }

  function renderPeople() {
    const state = presence.get();
    const name = selfName();
    const lists = { red: state.red.slice(), blue: state.blue.slice() };
    core.TEAMS.forEach((team) => {
      let list = lists[team];
      let me = null;
      if (team === myTeam) {
        const index = name ? list.findIndex((person) => person.name.toLowerCase() === name.toLowerCase()) : -1;
        if (index >= 0) me = list.splice(index, 1)[0];
        me = {
          name: name || 'You',
          anonymous: me ? me.anonymous : account.getState().status !== 'authenticated',
          status: document.visibilityState === 'visible' ? 'online' : (me ? me.status : 'online'),
          self: true,
        };
      }
      list = list.sort(byName);
      if (me) list.unshift(me);
      lists[team] = list;
    });
    stage.setPeople(lists);
    el.redMeta.textContent = plural(lists.red.length, 'on the rope', 'on the rope');
    el.blueMeta.textContent = plural(lists.blue.length, 'on the rope', 'on the rope');
  }

  // Tells you when someone grabs the rope or lets go. The first list is just a starting point.
  let known = null;
  function announce(state) {
    if (state.status !== 'online') return;
    const me = (selfName() || '').toLowerCase();
    const next = new Map();
    core.TEAMS.forEach((team) => state[team].forEach((person) => {
      const key = team + ':' + person.name.toLowerCase();
      if (person.name.toLowerCase() !== me && !next.has(key)) next.set(key, { team, name: person.name });
    }));
    if (known) {
      let shown = 0;
      next.forEach((person, key) => {
        if (!known.has(key) && shown++ < 3) toast(person.name + ' joined ' + TEAM_NAMES[person.team] + '!', person.team);
      });
      known.forEach((person, key) => {
        if (!next.has(key) && shown++ < 3) toast(person.name + ' let go of the rope.', person.team);
      });
    }
    known = next;
  }

  // ---------- Pulling ----------

  function pull(clientX, clientY) {
    if (!myTeam) return;
    if (!rope.pull(myTeam)) {
      el.halves[myTeam].classList.remove('is-straining');
      void el.halves[myTeam].offsetWidth;
      el.halves[myTeam].classList.add('is-straining');
      return;
    }
    stage.tug(myTeam);
    if (clientX === undefined) {
      const box = el.halves[myTeam].getBoundingClientRect();
      clientX = box.left + box.width / 2;
      clientY = box.top + box.height * 0.3;
    }
    stage.floater(myTeam, clientX, clientY);
  }

  // ---------- Being given a team ----------

  // Nobody chooses a side: once we know you don't already have one this round, you take the
  // next ticket and it decides (see core.teamForTicket). If the ticket can't be had, a coin
  // flip does instead, so nobody is left standing on the sidelines.
  let assigning = null;
  async function maybeAssign() {
    const state = teams.get();
    const snap = rope.snapshot();
    if (state.team || !state.settled || snap.key !== state.key || assigning === state.key) return;
    const key = state.key;
    assigning = key;
    let team;
    try {
      const ticket = await rope.ticket();
      if (ticket.key !== key) return;
      team = ticket.team;
    } catch (error) {
      team = Math.random() < 0.5 ? 'red' : 'blue';
    } finally {
      if (assigning === key) assigning = null;
    }
    if (teams.assign(key, team)) toast('You’re on ' + TEAM_NAMES[team] + '! Tap your side to pull.', team);
  }

  core.TEAMS.forEach((team) => {
    const half = el.halves[team];
    half.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0 || myTeam !== team) return;
      event.preventDefault(); // No text selection or focus flash while clicking fast.
      pull(event.clientX, event.clientY);
    });
  });

  // Space or Enter pulls from anywhere, as long as it isn't pressing a button.
  document.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    if (!myTeam || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (signIn.isOpen() || event.target.closest('button, a, input, textarea, select, dialog')) return;
    event.preventDefault();
    pull();
  });

  // ---------- Wins ----------

  let celebrateTimer = null;
  function celebrate(win) {
    clearTimeout(celebrateTimer);
    const box = el.celebrate;
    box.dataset.team = win.team;
    box.querySelector('.celebrate__kicker').textContent = 'Round ' + (win.round + 1);
    box.querySelector('.celebrate__title').textContent = TEAM_NAMES[win.team] + ' wins!';
    const mine = myTeam === win.team ? 'Your team did it. ' : myTeam ? 'So close. ' : '';
    box.querySelector('.celebrate__text').textContent = mine
      + 'The rope resets now, with new teams for round ' + (win.round + 2) + '.';
    const confetti = box.querySelector('.celebrate__confetti');
    confetti.replaceChildren();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (let i = 0; i < (reduced ? 0 : 48); i++) {
      const bit = document.createElement('i');
      bit.style.left = (Math.random() * 100) + '%';
      bit.style.setProperty('--delay', (Math.random() * 0.6).toFixed(2) + 's');
      bit.style.setProperty('--spin', (Math.random() * 720 - 360).toFixed(0) + 'deg');
      bit.style.setProperty('--fall', (2.2 + Math.random() * 1.6).toFixed(2) + 's');
      bit.className = Math.random() < 0.7 ? 'bit--team' : 'bit--gold';
      confetti.append(bit);
    }
    box.hidden = false;
    celebrateTimer = setTimeout(() => {
      box.hidden = true;
    }, 6500);
  }
  el.celebrate.addEventListener('click', () => {
    el.celebrate.hidden = true;
  });

  // ---------- Account ----------

  function openSignIn(trigger) {
    const state = account.getState();
    signIn.open({ trigger, stage: state.status === 'incomplete' || state.status === 'action' ? state.status : 'confirm' });
  }

  function renderAccount(state) {
    const button = el.accountButton;
    if (state.status === 'authenticated') {
      button.textContent = state.username;
      button.dataset.state = 'signed-in';
      button.title = 'Signed in with retrac.space';
    } else {
      button.textContent = state.status === 'action' ? 'Account needs attention'
        : state.status === 'incomplete' ? 'Finish your account' : 'Sign in';
      button.dataset.state = 'guest';
      button.title = '';
    }
    button.hidden = state.status === 'unknown';
  }

  el.accountButton.addEventListener('click', () => {
    if (account.getState().status === 'authenticated') window.open('https://accounts.retrac.space', '_blank', 'noopener');
    else openSignIn(el.accountButton);
  });

  // ---------- Wiring ----------

  rope.on('round', (snap) => {
    if (currentWeek && snap.week !== currentWeek) toast('A new week, a fresh rope, new teams!');
    currentWeek = snap.week;
    roundKey = snap.key;
    myPulls = 0;
    savedPulls = loadMine(snap.key);
    last = null;
    known = null; // Everyone lets go between rounds. That's not news.
    teams.setRound(snap.key);
  });
  rope.on('change', (snap) => {
    renderRope(snap);
    maybeAssign();
  });
  rope.on('win', celebrate);

  teams.subscribe((state) => {
    myTeam = state.team;
    presence.setTeam(state.team);
    renderTeam(state);
    renderPeople();
    if (last && myTeam) renderRope(rope.snapshot());
    maybeAssign();
  });

  presence.subscribe((state) => {
    announce(state);
    renderPeople();
  });

  account.subscribe((state) => {
    renderAccount(state);
    renderPeople();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderPeople();
  });
  setInterval(() => {
    el.reset.textContent = 'Resets in ' + untilReset(core.weekEnd(Date.now()));
  }, 30000);

  renderAccount(account.getState());
  renderTeam(teams.get());
  renderRope(rope.snapshot());
  renderPeople();
  account.check();
  rope.start();
  presence.start();
})();
