/*
 * Draws the arena: a stick figure on the rope for everyone online on each side, and the
 * rope itself sliding toward whichever team is ahead.
 *
 * Figures are kept between updates (keyed by name) so they don't flicker or restart their
 * animations every few seconds. Names come from other visitors, so they're only ever set
 * with textContent.
 */
(function () {
  'use strict';

  const core = window.TugCore;
  const arena = document.getElementById('arena');
  const rig = document.getElementById('rig');
  const crews = { red: document.getElementById('crewRed'), blue: document.getElementById('crewBlue') };
  const MAX_FIGURES = 40; // Per side. Everyone else is summed up in a "+N more" tag.
  const MAX_SHIFT = 16; // How far (in % of the arena) the rope's middle travels to a win line.
  const TAG_WIDTH = 96;
  const TUG_GAP_MS = 280;
  const lastTug = { red: 0, blue: 0 };

  function figureKey(person, seen) {
    if (person.self) return 'self';
    if (!person.anonymous) return 'name:' + person.name.toLowerCase();
    // Two strangers can share an animal, so they're told apart by order.
    const base = 'anon:' + person.name;
    const index = seen.get(base) || 0;
    seen.set(base, index + 1);
    return base + '#' + index;
  }

  function createFigure(team) {
    const figure = document.createElement('div');
    figure.className = 'fig fig--' + team + ' fig--enter';
    figure.innerHTML = '<div class="fig__pose"><svg class="fig__body" viewBox="0 0 60 100" aria-hidden="true">'
      + '<use href="#stick"></use></svg></div><span class="fig__tag"></span>';
    figure.addEventListener('animationend', () => figure.classList.remove('fig--enter'), { once: true });
    return figure;
  }

  function renderCrew(team, list) {
    const crew = crews[team];
    const existing = new Map();
    crew.querySelectorAll('.fig').forEach((figure) => existing.set(figure.dataset.key, figure));
    const seen = new Map();
    const shown = list.slice(0, MAX_FIGURES);
    const figures = shown.map((person) => {
      const key = figureKey(person, seen);
      let figure = existing.get(key);
      if (figure) existing.delete(key);
      else {
        figure = createFigure(team);
        figure.dataset.key = key;
      }
      const label = person.self ? person.name + ' (you)' : person.name;
      const tag = figure.querySelector('.fig__tag');
      if (tag.textContent !== label) tag.textContent = label;
      figure.title = label + (person.status === 'idle' ? ' · idle' : '');
      figure.classList.toggle('fig--self', Boolean(person.self));
      figure.classList.toggle('fig--idle', person.status === 'idle');
      figure.classList.toggle('fig--named', !person.anonymous);
      return figure;
    });
    existing.forEach((figure) => figure.remove());
    figures.forEach((figure, index) => {
      if (crew.children[index] !== figure) crew.insertBefore(figure, crew.children[index] || null);
    });

    let more = crew.querySelector('.crew__more');
    const hidden = list.length - shown.length;
    if (hidden > 0) {
      if (!more) {
        more = document.createElement('span');
        more.className = 'crew__more';
      }
      more.textContent = '+' + hidden.toLocaleString() + ' more';
      crew.append(more);
    } else if (more) more.remove();
  }

  // Spreads each crew along its half of the rope, front (nearest the middle) to back.
  function layout() {
    const width = arena.clientWidth;
    if (!width) return;
    const figureWidth = parseFloat(getComputedStyle(arena).getPropertyValue('--fig-w')) || 50;
    core.TEAMS.forEach((team) => {
      const crew = crews[team];
      const figures = Array.from(crew.querySelectorAll('.fig'));
      const count = figures.length;
      const front = Math.max(figureWidth * 0.95, width * 0.05);
      const room = Math.max(0, width * 0.4 - front);
      const spacing = count > 1 ? Math.min(figureWidth * 1.4, room / (count - 1)) : 0;
      const levelsNeeded = count > 1 && spacing < TAG_WIDTH ? Math.ceil(TAG_WIDTH / Math.max(spacing, 1)) : 1;
      const tagsFit = levelsNeeded <= 3;
      const side = team === 'red' ? -1 : 1;
      figures.forEach((figure, index) => {
        const offset = front + index * spacing;
        figure.style.left = (50 + (side * offset / width) * 100) + '%';
        figure.style.zIndex = String(count - index);
        figure.style.setProperty('--i', index);
        figure.style.setProperty('--level', tagsFit ? index % levelsNeeded : 0);
        figure.classList.toggle('fig--tagless', !tagsFit && !figure.classList.contains('fig--self'));
      });
      const more = crew.querySelector('.crew__more');
      if (more) {
        const offset = front + Math.max(0, count - 1) * spacing + figureWidth * 0.9;
        more.style.left = (50 + (side * offset / width) * 100) + '%';
      }
    });
  }

  // people: { red: [person], blue: [person] }, each person { name, status, anonymous, self }.
  function setPeople(people) {
    renderCrew('red', people.red);
    renderCrew('blue', people.blue);
    layout();
  }

  function setPosition(redPercent) {
    const progress = (redPercent - 50) / (core.WIN_PERCENT - 50); // 1 means Red has won.
    rig.style.setProperty('--shift', (-progress * MAX_SHIFT).toFixed(3));
    arena.dataset.leader = progress > 0 ? 'red' : progress < 0 ? 'blue' : 'even';
  }

  // Every figure on that side leans back together, one after another down the line.
  function tug(team) {
    const now = performance.now();
    if (now - lastTug[team] < TUG_GAP_MS) return;
    lastTug[team] = now;
    const crew = crews[team];
    crew.classList.remove('is-tugging');
    void crew.offsetWidth; // Restart the animation.
    crew.classList.add('is-tugging');
    rig.classList.remove('is-tugged-' + team);
    void rig.offsetWidth;
    rig.classList.add('is-tugged-' + team);
  }

  function floater(team, clientX, clientY) {
    const box = arena.getBoundingClientRect();
    const plus = document.createElement('span');
    plus.className = 'floater floater--' + team;
    plus.textContent = '+1';
    plus.style.left = (clientX - box.left) + 'px';
    plus.style.top = (clientY - box.top) + 'px';
    plus.style.setProperty('--drift', ((Math.random() - 0.5) * 40).toFixed(1) + 'px');
    arena.append(plus);
    plus.addEventListener('animationend', () => plus.remove(), { once: true });
    setTimeout(() => plus.remove(), 1500);
  }

  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(arena);
  else window.addEventListener('resize', layout);

  window.TugStage = { setPeople, setPosition, tug, floater, layout };
})();
