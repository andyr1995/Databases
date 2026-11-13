# App Store listing for First Come

Copy and paste these into App Store Connect. Character limits are Apple's; the counts are in brackets.
Everything here is a starting point that you can reword.

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

## URLs (once the branch is merged and GitHub Pages has deployed)

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
