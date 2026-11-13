# First Come

*First come, first served. The order is the puzzle.*

An original logic puzzle for iPhone (and the web). Tap a block and its colour runs out along every arrow,
claiming each free square until something is in the way. A claimed square stays claimed, so whoever goes later
gets cut short. Every block goes once; fill every square. The whole puzzle is the order.

- **Play it in a browser:** <https://andyr1995.github.io/Databases/first-come/> (live once this is merged to
  `main`; GitHub Pages publishes the `docs/` folder).
- **Ship it to the App Store:** follow [SHIPPING.md](SHIPPING.md). Store text is in
  [store/listing.md](store/listing.md) and screenshots are in `store/screenshots/`.

## What is in the box

Paths that start with `docs/` are from the top of the repository; the rest are inside this folder.

| Path | What it is |
| --- | --- |
| `docs/first-come/` | **The game.** A static site with no build step: `index.html`, `css/`, `js/`. Also the privacy policy and support page that the App Store asks for. |
| `docs/first-come/js/levels-data.js` | 2,000 campaign levels and 2,200 Daily puzzles (to November 2032), generated ahead of time and each proven solvable. Beyond those, the game builds the very same levels on the device, in the background. |
| `docs/first-come/vendor/native-bridge.js` | Generated. The AdMob / in-app purchase / haptics code the game loads when it runs inside the iPhone app. Source: `src/bridge/`. |
| `app.config.json` | **The one file to edit before release:** bundle id, app name, version, AdMob ids, the Remove Ads product id. |
| `src/bridge/` | TypeScript source of the native bridge (adverts, consent, purchases, share sheet, haptics, storage). |
| `ios/` | The Xcode project (Capacitor 8, Swift Package Manager). Regenerated settings come from `scripts/configure-ios.mjs`; do not edit them by hand. |
| `scripts/` | Tools: build the bridge, configure the Xcode project, build the level tables, draw the icon, take the screenshots. |
| `test/`, `e2e/` | Automated tests. |
| `ci/` | Templates of the two GitHub Actions workflows (build on a Mac in the cloud; upload to TestFlight). They are installed, filled in, in `.github/workflows/` at the top of the repository. |
| `store/` | App Store text and screenshots. |

## Everyday commands

Run these inside this folder (`first-come/`). Node 22.18 or newer.

```
npm install            # once
npm test               # bridge tests + game logic tests (every shipped level is solved by the solver)
npm run test:e2e       # plays the real game in a headless phone-sized browser
npm run typecheck      # type-checks the native bridge against the real plugin typings
npm run sync           # rebuilds the bridge, copies the game into the Xcode project, applies app.config.json
npm run levels         # regenerates js/levels-data.js (deterministic: same output every time)
npm run art            # redraws the app icon, web icons and launch image
npm run screenshots    # retakes the App Store screenshots
```

To try the game locally, serve the web folder with any static server (from the top of the
repository: `npx serve docs/first-come`) and open it on your phone or in a narrow browser window.

Handy addresses while testing:

- `?level=120` jumps to a level, `?daily` opens today's Daily.
- `?ads=mock` turns on **simulated** adverts and purchases in the browser, so you can see where the banner sits,
  when a full-screen advert appears and how the rewarded-video flows behave. Add `&fast` to shorten the waits.

## How the money side works

All of it is in `docs/first-come/js/ads.js` (the rules) and `src/bridge/` (the real AdMob and StoreKit calls).

- **Banner** on the play screen only. Never on the home screen, never on the Daily.
- **Full-screen advert** only between campaign levels, when the player taps *Next level*: never before 8 levels
  have been finished, at most one every 3 levels, never within 110 seconds of the last one or of opening the app,
  and never straight after a rewarded video. Change the numbers in `AD_RULES`.
- **Rewarded video**, always the player's choice: a hint when they have none left, one extra heart per Daily, and
  repairing a streak after exactly one missed day.
- **Remove Ads** (one-off purchase, product id `remove_ads`): removes the banner and full-screen adverts and adds
  10 hints. Rewarded videos stay available.
- **The web version has no adverts at all**; there, rewards are simply given.

Until you put your own AdMob ids in `app.config.json` and set `"testing": false`, the app shows Google's test
adverts, which earn nothing. That is deliberate: clicking your own live adverts gets an AdMob account banned.

## What has and has not been verified

Verified on Linux, automatically, on every `npm test` / `npm run test:e2e`:

- The rules and the solver, against a brute-force search of every tap order.
- All 4,200 shipped levels parse, fit a phone screen and can be solved, none shows a misleading arrow or
  number, and the tables are exactly what the generator produces.
- Sessions, slips, hearts, streaks, saved games, the share text, and the advert timing rules.
- The whole game played in a headless Chromium at phone sizes, including the simulated advert and purchase flows.
- The native bridge's logic, with fake plugins standing in for AdMob and StoreKit.

Verified on a Mac, by the `iOS build` workflow on GitHub (it runs on every push that touches the game or this
folder):

- The Xcode project resolves its Swift packages and the app compiles for the iPhone simulator (first run:
  13 November 2026, Xcode 26.6, unsigned).

**Not verified, because it needs an Apple developer account, an AdMob account and a real iPhone:** signing and
the TestFlight upload, real AdMob adverts, the consent and tracking prompts, real purchases, haptics and the
share sheet on a device. Step 10 of SHIPPING.md is the checklist for that first run on a phone.

## Changing things

- **Name, web address, hint economy:** `docs/first-come/js/config.js`. The name also appears in
  `app.config.json`, `index.html`, `manifest.webmanifest`, the two help pages and `store/listing.md`.
- **Advert pacing:** `AD_RULES` in `docs/first-come/js/ads.js`.
- **Difficulty curve and new kinds of block:** `campaignRecipe()` and `dailyRecipe()` in
  `docs/first-come/js/gen.js`, then `npm run levels` and `npm test`. Changing the generator changes the shipped
  levels, including today's Daily, so do it between releases, not casually.
- **Colours and look:** `docs/first-come/css/app.css`. The icon is drawn by `scripts/make-art.mjs`.
