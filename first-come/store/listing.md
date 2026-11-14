# Store listings for First Come

Text to copy and paste into App Store Connect (first part) and Google Play Console (second part, at the end).
Character limits are the stores' own; the counts are in brackets. Everything here is a starting point that you
can reword.

# Part 1: Apple App Store

## Name (30 max)

    First Come: The Order Puzzle        [28]

If App Store Connect says the name is taken, try `First Come - Order Puzzle` or `First Come: Tap in Order`.
(Checked on 13 November 2026: no app on the App Store or Google Play began with "First Come". Apple also
reserves names for unreleased apps, which only App Store Connect can show.)

## Subtitle (30 max)

    A new logic puzzle every day        [28]

## Promotional text (170 max, can be changed without a new build)

    First come, first served. Every block claims the squares in its path, and each block goes once. Find the order that fills the board. New Daily puzzle every day.        [160]

## Description (4000 max)

    FIRST COME, FIRST SERVED.

    Tap a block and its colour runs out along every arrow, claiming each free square until something gets in the way. A claimed square stays claimed, so whoever goes later gets cut short.

    Every block goes once. Fill every square.

    That is the whole game: the order is the puzzle.

    WHY YOU WILL KEEP PLAYING
    • One rule, learned in ten seconds, with real depth behind it
    • 2,000 solver-checked levels, then endless generated ones
    • A new Daily puzzle every day, the same for everyone, with three hearts
    • Share your Daily as a row of squares that gives nothing away
    • Hold any block to peek at what it would claim before you commit
    • Never stuck: a wrong tap is undone for you and shown, so you learn why
    • Three stars for a flawless solve, and streaks for coming back
    • Plays offline, in portrait, with one thumb

    FAIR BY DESIGN
    • No timers and no lives in the main game
    • Hints are earned by playing; a short video gets you one when you run out
    • No adverts around the Daily puzzle
    • One optional purchase removes banners and adverts between levels for good

    Blocks come with one, two, three or four arrows, and later with numbers that limit their reach. Every level is checked by a solver before it ships, so there is always a way.

    Can you find the order?

## Keywords (100 max, comma separated, no spaces)

    logic,brain,teaser,daily,grid,tap,sequence,color,colour,fill,strategy,casual,offline,mind,relax        [95]

Do not repeat words that are already in the name or subtitle (Apple indexes those separately).

## Categories

- Primary: Games, with sub-categories Puzzle and Casual
- Do NOT tick "Made for Kids". The game shows third-party adverts, which the Kids category forbids.

## Age rating

Answer "None" / "No" to every content question (no violence, gambling, user-generated content, web browsing or
messaging). Where the questionnaire asks about advertising, answer yes. The result should be the lowest rating.
Rate it honestly rather than aiming for a number.

## What's New in this version

    The first release. Thank you for playing!

## URLs

These addresses show "404" until the website has been published. Merging to `main` may not be enough by itself:
follow "Publishing the website" in the [README](../README.md) and open each address in a browser before you
paste it anywhere.

- Marketing URL: https://andyr1995.github.io/Databases/first-come/
- Support URL:   https://andyr1995.github.io/Databases/first-come/support.html
- Privacy policy URL: https://andyr1995.github.io/Databases/first-come/privacy.html

Read the privacy policy before you publish it. It describes what the app does today (AdMob adverts, no
accounts, progress stored on the device). It is not legal advice; if you add analytics or accounts later it
must change.

## In-app purchase

- Type: Non-Consumable
- Product ID: `remove_ads` (must match `iap.removeAdsProductId` in `app.config.json`)
- Reference name: Remove Ads
- Display name: Remove Ads
- Description: Removes banners and adverts between levels, and adds 10 hints.
- Suggested price: £2.99 / $2.99

## Notes for App Review (paste into "App Review Information > Notes")

    First Come is an original logic puzzle. Each block claims squares in straight lines until blocked, each block
    goes once, and the player must find the order that fills the board. Levels are generated and verified by a
    solver; a tap that would make the board unsolvable is undone and counted as a "slip".

    The app works fully offline and needs no account. Adverts are served by Google AdMob; consent is collected with
    Google's User Messaging Platform before any advert is requested, followed by the App Tracking Transparency
    prompt. "Privacy choices" in Settings reopens the consent form where it applies.

    Remove Ads is a non-consumable purchase. "Restore purchases" is in Settings and on the Remove Ads screen.

    Rewarded videos are always optional: they are offered for a hint when the player has none left, for one extra
    heart in the Daily puzzle, and to repair a missed-day streak.

## Screenshots

`npm run screenshots` (inside `first-come/`) writes five 1320 x 2868 PNGs (the 6.9-inch iPhone size) to
`store/screenshots/`. Upload them in this order: 1 play, 2 slip, 3 daily, 4 result, 5 home. Apple scales the
6.9-inch set for smaller iPhones, so no other size is required for an iPhone-only app.

# Part 2: Google Play

Play Console > your app > Grow users > Store presence > Main store listing. The step-by-step guide for
everything else on the Android side (account, signing, the purchase, the Data safety form) is
[SHIPPING-ANDROID.md](../SHIPPING-ANDROID.md).

## App name (30 max)

    First Come: The Order Puzzle        [28]

## Short description (80 max)

    Tap the blocks in the right order to fill the board. A new puzzle every day.        [76]

## Full description (4000 max)

Use the App Store description above as it is. Google Play shows it as plain text; the bullet points and the
headings in capitals are fine there.

## Graphics

| What | Size Play asks for | File |
| --- | --- | --- |
| App icon | 512 x 512 PNG | `resources/play/icon-512.png` |
| Feature graphic | 1024 x 500 PNG or JPEG | `resources/play/feature-graphic-1024x500.png` |
| Phone screenshots (2 to 8) | 16:9 or 9:16, each side 320 to 3840 px | `store/screenshots-android/` (five, 1080 x 1920) |

Upload the screenshots in the same order: 1 play, 2 slip, 3 daily, 4 result, 5 home. Do not upload the iPhone
set to Play: at 1320 x 2868 it is taller than the 2:1 that Play allows. `npm run art` and `npm run screenshots`
recreate all of these (both need Playwright: see "Everyday commands" in the README).

## Category and contact details

- App or game: Game. Category: Puzzle.
- Email address: **required by Google Play** and shown publicly on the listing. Use an address you are happy
  to publish.
- Website: https://andyr1995.github.io/Databases/first-come/
- Privacy policy: https://andyr1995.github.io/Databases/first-come/privacy.html (required, because the app
  shows adverts)

Both addresses must be live before you enter them: see "Publishing the website" in the [README](../README.md).

## In-app product

Play Console > your app > Monetize with Play > Products > One-time products (formerly called in-app products; not a
subscription). Step 13 of SHIPPING-ANDROID.md walks through it.

- Product ID: `remove_ads` (must match `iap.removeAdsProductId` in `app.config.json`; it cannot be changed or
  reused once created)
- Name: Remove Ads
- Description: Removes banners and adverts between levels, and adds 10 hints.
- Purchase option ID: `buy` (your choice; lower-case letters, numbers and hyphens only; the game does not use it)
- Purchase type: Buy (not Rent)
- Suggested price: £2.99 / $2.99
