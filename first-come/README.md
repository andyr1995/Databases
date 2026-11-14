# First Come

*First come, first served. The order is the puzzle.*

An original logic puzzle for iPhone, Android and the web. Tap a block and its colour runs out along every arrow,
claiming each free square until something is in the way. A claimed square stays claimed, so whoever goes later
gets cut short. Every block goes once; fill every square. The whole puzzle is the order.

- **Play it in a browser:** <https://andyr1995.github.io/Databases/first-come/>. Not live yet, and merging this
  to `main` may not be enough by itself: see "Publishing the website" below.
- **Merge this into `main` first.** It was written on a branch, and GitHub only lets you start a workflow
  by hand ("Run workflow") once its file is on the default branch, `main`. Until then the two release
  workflows ("Android release" and "iOS TestFlight") are not even listed under Actions.
- **Ship it to the App Store:** follow [SHIPPING.md](SHIPPING.md).
- **Ship it to Google Play:** follow [SHIPPING-ANDROID.md](SHIPPING-ANDROID.md).
- **Try it on an Android phone today:** every push builds an installable test app. On GitHub open
  Actions > "Android build" > the latest run > Artifacts, and download the `.apk` on the phone
  (step 11 of SHIPPING-ANDROID.md). It shows Google's test adverts and cannot take real payments.
- Store text for both stores is in [store/listing.md](store/listing.md); screenshots are in
  `store/screenshots/` (App Store) and `store/screenshots-android/` (Google Play); the Play icon and
  feature graphic are in `resources/play/`.

## What is in the box

Paths that start with `docs/` are from the top of the repository; the rest are inside this folder.

| Path | What it is |
| --- | --- |
| `docs/first-come/` | **The game.** A static site with no build step: `index.html`, `css/`, `js/`. Also the privacy policy and support page that both stores ask for. |
| `docs/first-come/js/levels-data.js` | 2,000 campaign levels and 2,200 Daily puzzles (to November 2032), generated ahead of time and each proven solvable. Beyond those, the game builds the very same levels on the device, in the background. |
| `docs/first-come/vendor/native-bridge.js` | Generated. The AdMob / in-app purchase / haptics / Back-button code the game loads when it runs inside the iPhone or Android app. Source: `src/bridge/`. |
| `app.config.json` | **The one file to edit before release:** app id (iPhone bundle id and Android package name), app name, version, AdMob ids for each platform, the Remove Ads product id. |
| `src/bridge/` | TypeScript source of the native bridge (adverts, consent, purchases, share sheet, haptics, storage, Android Back). |
| `ios/` | The Xcode project (Capacitor 8, Swift Package Manager). Regenerated settings come from `scripts/configure-ios.mjs`; do not edit them by hand. |
| `android/` | The Android project (Capacitor 8, Gradle). Regenerated settings come from `scripts/configure-android.mjs`; do not edit them by hand. The copied web game inside it is not committed: run `npm run sync` before any Gradle build. |
| `scripts/` | Tools: check the config, build the bridge, configure the Xcode and Android projects, build the level tables, draw the icons, take the screenshots. |
| `test/`, `e2e/` | Automated tests. |
| `ci/` | Templates of the four GitHub Actions workflows (iPhone: build on a Mac, upload to TestFlight; Android: build an installable test app, build the signed bundle for Google Play). They are installed, filled in, in `.github/workflows/` at the top of the repository. |
| `resources/` | The app icon and launch image, Android launcher icons, and the Google Play icon and feature graphic. All drawn by `npm run art`. |
| `store/` | Text and screenshots for both stores. |

## Everyday commands

Run these inside this folder (`first-come/`). Node 22.18 or newer.

```
npm install            # once
npm test               # bridge tests + game logic tests (every shipped level is solved by the solver)
npm run test:e2e       # plays the real game in a headless phone-sized browser
npm run typecheck      # type-checks the native bridge against the real plugin typings
npm run sync           # checks app.config.json, rebuilds the bridge, copies the game into the Xcode and
                       # Android projects and applies app.config.json to both
npm run levels         # regenerates js/levels-data.js (deterministic: same output every time)
npm run art            # redraws the app icons, web icons, launch image and Google Play art
npm run screenshots    # retakes the App Store and Google Play screenshots
```

`npm run test:e2e`, `npm run art` and `npm run screenshots` drive a headless Chromium through Playwright, which
`npm install` does not bring. A Claude Code cloud session already has both. On any other computer these three
stop with `Cannot find module 'playwright'` until you run, in this folder:

```
npm install --no-save playwright
npx playwright install chromium
```

`--no-save` is on purpose: a copy written into `package.json` would take the place of the one in a cloud session
and ask for a browser that session does not have. A later `npm install` removes Playwright again, so repeat the
first line after one.

To build the Android app on your own computer (needs Java 21 and the Android SDK; Android Studio
brings both): `npm run sync`, then in `android/` run `./gradlew assembleDebug`. The app is then at
`android/app/build/outputs/apk/debug/app-debug.apk`. Or open `android/` in Android Studio and press Run.

To try the game locally, serve the web folder with any static server (from the top of the
repository: `npx serve docs/first-come`) and open it on your phone or in a narrow browser window.

Handy addresses while testing:

- `?level=120` jumps to a level, `?daily` opens today's Daily.
- `?ads=mock` turns on **simulated** adverts and purchases in the browser, so you can see where the banner sits,
  when a full-screen advert appears and how the rewarded-video flows behave. Add `&fast` to shorten the waits.

## How the money side works

All of it is in `docs/first-come/js/ads.js` (the rules) and `src/bridge/` (the real AdMob, StoreKit and
Google Play Billing calls). The rules are the same on iPhone and Android.

- **Banner** on the play screen only. Never on the home screen, never on the Daily.
- **Full-screen advert** only between campaign levels, after the player taps *Next level*: never before 12
  levels have been finished, at most one every 3 levels, never within 110 seconds of the last one or of opening
  or returning to the app, and never straight after a rewarded video watched to the end. It is announced for a
  moment first, so it never appears under a finger. Change the numbers in `AD_RULES`.
- **Rewarded video**, always the player's choice: a hint when they have none left, one extra heart per Daily, and
  repairing a streak after exactly one missed day (at most once a week). A video closed early pays nothing.
- While an advert is on its way the screen is covered, and if it has not appeared after 12 seconds the player is
  offered a way back to the game, so a failed advert can never lock the game.
- **Remove Ads** (one-off purchase, product id `remove_ads`): removes the banner and full-screen adverts and adds
  10 hints. Rewarded videos stay available.
- **The web version has no adverts at all**; there, rewards are simply given.

Until you put your own AdMob ids in `app.config.json` (the iPhone app and the Android app each need their
own set) and set `"testing": false`, the app shows Google's test adverts, which earn nothing. That is
deliberate: clicking your own live adverts gets an AdMob account banned.

## Publishing the website

The web game, the privacy policy and the support page are the `docs/first-come/` folder. One workflow publishes
the whole `docs/` folder to GitHub Pages: `.github/workflows/update-prices.yml` ("Update fuel prices and
deploy"), which belongs to the fuel price app in this repository. Nothing else publishes the pages.

GitHub has had that workflow switched off since 1 October 2026 (checked 14 November 2026). It does that to
scheduled workflows when a public repository has had no activity for 60 days. A workflow that is switched off
is not started by a push, so until it is switched on the addresses show "404". After merging to `main`:

1. On GitHub open Actions > "Update fuel prices and deploy". If the page says the workflow is disabled, press
   **Enable workflow**.
2. Press **Run workflow** (branch `main`) and wait for the run to turn green. It fetches the fuel prices first;
   if that step fails nothing is published, so run it again later.
3. Open <https://andyr1995.github.io/Databases/first-come/privacy.html> and
   <https://andyr1995.github.io/Databases/first-come/support.html> in a browser. Give the addresses to Apple,
   Google or AdMob only when both show the page. The game's own "Privacy policy" and "Help and contact" rows
   open the same two addresses.

GitHub switches the workflow off again after another 60 days without activity. Pages already published stay
up, but later changes to the web game or to these pages will not appear until it is switched on again.

## Before you submit: things only you can do

1. **Choose the app id** in `app.config.json` (`appId`). It is `app.firstcome.puzzle` now. It is the iPhone
   bundle id and the Android package name, and it cannot be changed in either store after the first upload.
   Use letters, digits and dots only (Android refuses hyphens).
2. **Put your own AdMob ids** in `app.config.json`, under `admob.ios` and `admob.android`, and set
   `"testing": false` for the release builds.
3. **Add your name and a contact e-mail address** to `docs/first-come/support.html` and to the last section of
   `docs/first-come/privacy.html`. Today the only contact route is a public GitHub issue, which needs an account
   and is visible to everyone. Apple asks for an easy way to reach you, Google Play requires a contact e-mail
   address and shows it on the listing, and UK/EU privacy rules expect the policy to say who is responsible
   and how to contact them privately.
4. **Read the privacy policy** before publishing it. It describes what the app does today; it is not legal advice.
5. **Check the name** `First Come` in App Store Connect (step 3 of SHIPPING.md). The earlier working title,
   Dibs, was dropped because a colour-capture puzzle game already uses it.
6. **Google Play only: allow time for testing.** A new personal Play developer account has to run a closed
   test with real testers before it may publish to everyone (at least 12 testers for 14 days when this was
   written, 14 November 2026). Step 2 of SHIPPING-ANDROID.md has the details; start that clock early.
7. **Publish the website** ("Publishing the website" above) and open the privacy policy and the support page in
   a browser. Both stores and AdMob ask for those addresses, and the game links to them.

## What has and has not been verified

Verified on Linux, automatically, on every `npm test` / `npm run test:e2e`:

- The rules and the solver, against a brute-force search of every tap order.
- All 4,200 shipped levels parse, fit a phone screen and can be solved, none shows a misleading arrow or
  number, and the tables are exactly what the generator produces.
- Sessions, slips, hearts, streaks, saved games, the share text, and the advert timing rules.
- The whole game played in a headless Chromium at phone sizes, including the simulated advert and purchase
  flows and Android's Back button.
- The native bridge's logic on both platforms, with fake plugins standing in for AdMob, StoreKit and Google
  Play Billing. The Android fakes are written from the plugins' own Java source, and a test fails if that
  source changes at a place the bridge relies on.
- That `app.config.json`, the Xcode project and the Android project agree.

Verified on a Mac, by the `iOS build` workflow on GitHub (it runs on every push that touches the game or this
folder, apart from Android-only files):

- The Xcode project resolves its Swift packages and the app compiles for the iPhone simulator (first run:
  13 November 2026, Xcode 26.6, unsigned).

Verified for Android, by the `Android build` workflow on GitHub (every push that touches the game or this
folder) and by the same Gradle build on a Linux machine:

- The Android project downloads its libraries and builds a debug APK and a release app bundle (unsigned).
  Both are then opened and checked: package name, version, name, permissions, the AdMob app id, portrait,
  and that the game and the freshly built bridge are inside (first run on GitHub: 14 November 2026, passed).
  The debug APK is kept with each run, ready to install on a phone.

**Not verified, because it needs developer accounts, an AdMob account and real phones:** the app running on
any device (iPhone or Android), signing and the TestFlight and Google Play uploads, real AdMob adverts, the
consent and tracking prompts, real purchases, haptics, the share sheet, and on Android the launch screen, the
edges of the screen around the system bars, and the Back button on a phone. Step 10 of SHIPPING.md and step 15
of SHIPPING-ANDROID.md are the checklists for that first run on a phone.

## Changing things

- **Name, web address, hint economy:** `docs/first-come/js/config.js`. The name also appears in
  `app.config.json`, `index.html`, `manifest.webmanifest`, the two help pages and `store/listing.md`, and it is
  drawn into the Google Play feature graphic by `feature()` in `scripts/make-art.mjs` (then `npm run art` and
  `npm run screenshots`).
- **Advert pacing:** `AD_RULES` in `docs/first-come/js/ads.js`.
- **Difficulty curve and new kinds of block:** `campaignRecipe()` and `dailyRecipe()` in
  `docs/first-come/js/gen.js`, then `npm run levels` and `npm test`. Changing the generator changes the shipped
  levels, including today's Daily, so do it between releases, not casually.
- **Colours and look:** `docs/first-come/css/app.css`. The icon is drawn by `scripts/make-art.mjs`.
