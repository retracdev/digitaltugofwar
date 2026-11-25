/*
 * The small sign-in dialog, following Simple Soundboard's flow. Its main button goes to the
 * retrac.space guided sign-in page in this tab, which sends the visitor back here with
 * ?signed-in, and a "You're signed in" popup greets them. The other screens still open
 * accounts in a new tab, and this page notices when the visitor comes back and checks
 * their session again.
 */
(function () {
  'use strict';

  const account = window.RetracAccount;
  const ACCOUNTS_URL = 'https://accounts.retrac.space';
  const GUIDED_URL = ACCOUNTS_URL + '/guided-setup';
  const SITE_URL = 'https://tugofwar.retrac.space/';
  // 960x1200, made by `npm run build:art`. Guided setup only shows art from retrac.space.
  const GUIDED_IMAGE = SITE_URL + 'assets/social/guided-setup.jpg';
  const RETURN_PARAM = 'signed-in';

  // What each reason from accounts means for the visitor. Any other reason gets no sentence.
  const ACTION_REASONS = {
    account_review: 'Your account needs a quick review. There may be a few steps to verify it’s really you.',
    inappropriate_username: 'Your username isn’t allowed and needs to be changed.',
    inappropriate_content: 'Some of what you’ve posted on retrac.space needs to be removed.',
    account_suspended: 'Your account is temporarily unavailable.',
    auth_unlink_google: 'Sign in with Google is no longer available for your account. Set a new password to avoid being locked out.',
  };

  const screens = {
    confirm: {
      title: 'Put your name on the rope',
      description: 'Sign in with your retrac.space account to show your username on your stick figure and keep your team on every device. We’ll bring you right back here when you’re done.',
      actions: [['guided', 'Sign in or create account'], ['cancel', 'Not now']],
    },
    waiting: {
      title: 'Finish signing in',
      description: 'Sign in or create your account in the new tab. When you’re finished, come back here.',
      actions: [['verify', 'I’ve signed in'], ['open', 'Open accounts again'], ['cancel', 'Cancel']],
    },
    checking: {
      title: 'Checking your account',
      description: 'Just a moment.',
      actions: [['cancel', 'Cancel']],
    },
    guest: {
      title: 'Not signed in yet',
      description: 'We couldn’t find your account. Finish signing in, then come back and try again.',
      actions: [['verify', 'Try again'], ['open', 'Open accounts'], ['cancel', 'Cancel']],
    },
    error: {
      title: 'Couldn’t check your account',
      description: 'We couldn’t reach retrac.space just now. Please try again in a moment. You can keep pulling without signing in.',
      actions: [['verify', 'Try again'], ['open', 'Open accounts'], ['cancel', 'Cancel']],
    },
    incomplete: {
      title: 'Finish setting up your account',
      description: 'Choose a username at retrac.space so it can go on your stick figure, then come back here.',
      actions: [['open', 'Open accounts'], ['verify', 'I’ve finished'], ['cancel', 'Cancel']],
    },
    action: {
      title: 'Action is required on your account',
      description: 'You can keep pulling, but account features are off until it’s resolved.',
      actions: [['resolve', 'Resolve Issue'], ['cancel', 'Continue Signed Out']],
    },
  };

  const dialog = document.createElement('dialog');
  dialog.className = 'signin-dialog';
  dialog.setAttribute('aria-labelledby', 'signin-title');
  dialog.setAttribute('aria-describedby', 'signin-description');
  document.body.append(dialog);

  let stage = 'confirm';
  let started = false;
  let away = false;
  let trigger = null;
  let flow = 0;
  let returnTimer = null;

  function render(next) {
    stage = next;
    const screen = { ...screens[next] };
    if (next === 'action') {
      const reason = ACTION_REASONS[account.getState().reason];
      if (reason) screen.description = reason + ' ' + screen.description;
    }
    const waiting = next === 'waiting' || next === 'checking';
    dialog.innerHTML = `<section class="signin-panel">
      <div class="signin-brand"><img src="assets/alt-favicon.png" alt=""><span>retrac.space</span></div>
      <h2 id="signin-title">${screen.title}</h2>
      <p id="signin-description">${screen.description}</p>
      ${waiting ? '<p class="signin-waiting" role="status"><span aria-hidden="true"></span>Waiting for your account</p>' : ''}
      <div class="signin-actions">${screen.actions.map(([action, label], i) => {
        const cls = i ? 'signin-button signin-button--quiet' : 'signin-button';
        // A plain link: an ordinary trip to accounts and back, in this tab.
        if (action === 'guided') return `<a class="${cls}" data-action="guided" href="${escapeAttr(guidedUrl())}">${label}</a>`;
        return `<button type="button" class="${cls}" data-action="${action}">${label}</button>`;
      }).join('')}
      </div>
    </section>`;
    if (dialog.open) dialog.querySelector('[data-action]').focus({ preventScroll: true });
  }

  function escapeAttr(text) {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // Guided setup only sends people back to retrac.space sites and localhost, so anywhere
  // else (a preview host, say) comes back to the real site instead.
  function returnUrl() {
    const here = new URL(window.location.href);
    const host = here.hostname;
    const allowed = /^https?:$/.test(here.protocol)
      && (host === 'retrac.space' || host.endsWith('.retrac.space') || host === 'localhost');
    const url = allowed ? here : new URL(SITE_URL);
    url.searchParams.set(RETURN_PARAM, '1');
    return url.href;
  }

  function guidedUrl() {
    const params = new URLSearchParams({ app: 'Digital Tug of War', redirect: returnUrl(), image: GUIDED_IMAGE });
    return GUIDED_URL + '?' + params;
  }

  function close() {
    flow++;
    started = false;
    away = false;
    clearTimeout(returnTimer);
    if (dialog.open) dialog.close();
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    trigger = null;
  }

  function openAccounts() {
    // Runs directly in a button click, so browsers allow the new tab.
    started = true;
    away = false;
    window.open(ACCOUNTS_URL, '_blank', 'noopener');
    render('waiting');
  }

  function resolveIssue() {
    started = true;
    away = false;
    window.open(account.getState().url || ACCOUNTS_URL, '_blank', 'noopener');
  }

  async function verify() {
    clearTimeout(returnTimer);
    if (!dialog.open || stage === 'checking') return;
    away = false;
    const current = flow;
    render('checking');
    const session = await account.check();
    if (!dialog.open || flow !== current) return;
    if (session.status === 'authenticated') {
      close();
      return;
    }
    render(screens[session.status] ? session.status : 'error');
  }

  function markAway() {
    if (dialog.open && started) away = true;
  }

  function onReturn() {
    if (!dialog.open || !started || !away || document.hidden || !document.hasFocus()) return;
    away = false;
    clearTimeout(returnTimer);
    // visibilitychange and focus usually arrive together, so act on just one of them.
    returnTimer = setTimeout(() => {
      if (document.hidden || !document.hasFocus()) markAway();
      else verify();
    }, 200);
  }

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
      return;
    }
    const button = event.target.closest('[data-action]');
    // The link leaves for accounts on its own, and the dialog stays as it is until then.
    if (!button || button.dataset.action === 'guided') return;
    if (button.dataset.action === 'open') openAccounts();
    else if (button.dataset.action === 'resolve') resolveIssue();
    else if (button.dataset.action === 'verify') verify();
    else close();
  });

  // The dialog's keys belong to it, not to pulling.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) markAway();
    else onReturn();
  });
  window.addEventListener('blur', markAway);
  window.addEventListener('focus', onReturn);

  // Signing in anywhere (another tab, a recheck) finishes the dialog's job.
  account.subscribe((state) => {
    if (state.status === 'authenticated' && dialog.open) close();
  });

  // ---------- Back from guided setup ----------

  // Read once, then taken out of the address so a reload or a copied link doesn't repeat it.
  function takeReturnFlag() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has(RETURN_PARAM)) return false;
      url.searchParams.delete(RETURN_PARAM);
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
      return true;
    } catch (error) {
      return false;
    }
  }

  const returned = takeReturnFlag();

  const done = document.createElement('dialog');
  done.className = 'signin-dialog signed-in-dialog';
  done.setAttribute('aria-labelledby', 'signed-in-title');
  done.setAttribute('aria-describedby', 'signed-in-description');
  done.innerHTML = `<section class="signin-panel signed-in-panel">
      <svg class="signed-in-check" viewBox="0 0 52 52" aria-hidden="true">
        <circle class="signed-in-check__ring" cx="26" cy="26" r="23"></circle>
        <path class="signed-in-check__mark" d="m15.5 27 7 7 14-15"></path>
      </svg>
      <h2 id="signed-in-title">You’re signed in</h2>
      <p id="signed-in-description"></p>
      <div class="signin-actions"><button type="button" class="signin-button" data-action="done">Done</button></div>
    </section>`;
  document.body.append(done);

  done.addEventListener('click', (event) => {
    if (event.target === done || event.target.closest('[data-action="done"]')) done.close();
  });
  // Its keys belong to it too, so Space presses Done instead of pulling.
  done.addEventListener('keydown', (event) => event.stopPropagation());

  function showSignedIn(username) {
    if (dialog.open || done.open) return;
    // Usernames come from the account, so they must never be treated as HTML.
    done.querySelector('#signed-in-description').textContent =
      'Welcome, ' + username + '. Your name is on your stick figure, and your team now saves to your retrac.space account.';
    done.showModal();
    done.querySelector('button').focus({ preventScroll: true });
  }

  async function welcomeBack() {
    const state = await account.check();
    if (state.status === 'authenticated') showSignedIn(state.username);
    // Anything else (no username yet, an account issue, a failed check) gets its screen.
    else if (!dialog.open) window.TugSignIn.open({ stage: screens[state.status] ? state.status : 'error' });
  }

  if (returned) Promise.resolve().then(welcomeBack);

  window.TugSignIn = {
    isOpen: () => dialog.open || done.open,

    // True when this page load came straight back from guided setup.
    returnedFromSignIn: returned,

    open(options) {
      if (dialog.open) return;
      flow++;
      started = false;
      away = false;
      trigger = (options && options.trigger) || null;
      const stageName = options && options.stage;
      render(screens[stageName] ? stageName : 'confirm');
      dialog.showModal();
      dialog.querySelector('[data-action]').focus({ preventScroll: true });
    },
  };
})();
