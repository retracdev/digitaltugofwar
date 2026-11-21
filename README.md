# Digital Tug of War

Tug of war, online! 🚩 A digital social experience, part of the [retrac.space](https://retrac.space) collection.

Visit it at [tugofwar.retrac.space](https://tugofwar.retrac.space).

Pick a side, Red or Blue, then tap your side (or press <kbd>Space</kbd>) to pull. Everyone online shows up as a stick figure on their team's side of the rope, with their retrac.space username on their name tag, or an anonymous animal if they're not signed in. The percentages at the top show who has the rope.

## How it works

- **Each pull is worth 0.05%.** The rope starts at 50%. Every pull moves it 0.05% toward the puller's team, so 20 pulls move it 1%. Pulls from the other team cancel yours out.
- **First to 95% wins the round.** That takes a 900-pull lead. Then the rope resets and everyone picks a side again.
- **The rope also resets every week**, on Monday at 00:00 UTC.
- **You stay on your side until the rope resets.** Your team is saved in a browser cookie. If you're signed in to a retrac.space account, it's also saved to your account, so you're on the same side on every device.
- **You can pull even if nobody's on the other side.** Your team just has a big advantage.
- Pulls faster than 8 a second aren't counted.

## Under the hood

The site is plain HTML, CSS and JavaScript with no build step. It's hosted on GitHub Pages and uses the shared retrac.space services:

| What | Service |
| --- | --- |
| The rope | Public counters: `tugofwar-<week>-r<round>-red` and `-blue`. A pull is one increment. Fresh rounds and weeks use fresh counter names, since counters can't be reset. The first visitor to see a win also increments `-wonred` or `-wonblue`, which settles that round for good. |
| Stick figures | Public presence, with one site per side: `tugofwar-red`, `tugofwar-blue`, and `tugofwar` for people who haven't picked a side yet. |
| Signing in | retrac.space accounts (`get-session` and `/api/auth/token`), the same flow as Simple Soundboard. |
| Saving your team | The account cloud save for game `tugofwar`, slot 0: `{ version: 1, round, team, joinedAt }`. |

| File | What it does |
| --- | --- |
| `js/core.js` | The rules: what a pull is worth, when a round is won, week and counter names. No page code, so it's tested in Node. |
| `js/rope.js` | Finds the current round, watches the counters and sends pulls. |
| `js/team.js` | Your side this round, in a cookie and your cloud save. |
| `js/presence.js` | Heartbeats and who's online on each side. |
| `js/stage.js` | Draws the rope and the stick figures. |
| `js/app.js` | Wires it all together: scoreboard, pulling, wins, toasts. |
| `js/account.js`, `js/sign-in.js`, `js/account-welcome.js` | The retrac.space account, sign-in dialog and welcome pill, from Simple Soundboard. |

### Setup on the other retrac.space services

Counters and presence already allow every `*.retrac.space` site. Signing in and cloud saving need:

1. **space-accounts:** add `https://tugofwar.retrac.space` to `websiteOrigins` in `src/server/worker.ts` (for `get-session`), and to the `GAME_AUTH_ORIGINS` environment variable (for `/api/auth/token`).
2. **space-api:** add `https://tugofwar.retrac.space` to `ALLOWED_ORIGINS` in `wrangler.jsonc`, and register the game. Saves to an unknown game return `404 game_not_found`:

   ```sql
   INSERT INTO games (id, name, save_slots) VALUES ('tugofwar', 'Digital Tug of War', 1);
   ```

Until then, everything works except account features: teams are saved in the browser only.

## Development

Open `index.html` through any static server. The shared APIs only answer `retrac.space` sites, so locally the rope shows "Reconnecting…". `npm test` runs the tests in Node (no dependencies needed).
