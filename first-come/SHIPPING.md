# The iPhone app: from this repository to the App Store

This folder turns the web game into an iPhone app. It holds a Capacitor project (a thin native
shell that shows the game in a full-screen web view), the bridge that connects the game to
adverts, purchases and other iPhone features, and the Xcode project in `ios/`.

Read "Where things stand" and "The one rule" first. The numbered steps after that go from an
empty Apple account to a published app, in the order that causes the least waiting.

How far to trust this guide:

- Requirements that change (the membership price, the minimum Xcode, screenshot sizes, the
  age-rating questions, review times, what AdMob's software collects, the app-ads.txt rules,
  how API keys are made, which Xcode GitHub's runners have) were read from Apple's, Google's
  and GitHub's own pages on 13 November 2026.
- Menu paths and everyday facts about App Store Connect and AdMob are written from general
  knowledge of those sites. Menus move; if one is not where this guide says, search for the
  name of the thing.
- A line that says "needs checking" is something nobody here could confirm. Look it up
  before relying on it.

## Where things stand

- **Nothing has been built on a Mac yet.** The Xcode project, both CI workflows and the
  StoreKit test file were produced and checked on Linux, where Xcode does not exist. Expect
  the first Mac build to need a fix or two. "What has not been verified" at the end lists
  exactly what is unproven.
- **The app's identity is set but yours to change.** `app.config.json` calls the app
  `First Come` with the bundle id `app.firstcome.puzzle`. The bundle id cannot be changed
  after the first upload, so decide on it in step 3.
- **The adverts are Google's demo adverts.** `admob.testing` is `true` and the ids are
  Google's public sample ids. A build made now earns nothing.
- **The icon and launch image are real**, drawn by `scripts/make-art.mjs` (`npm run art`).

## The one rule

Everything about the app that can change lives in two places:

- `app.config.json`: name, bundle id, version, AdMob ids, the product id of the purchase;
- `resources/`: the icon and the launch image.

After changing either, run this in this folder and commit everything it changes:

```
npm run sync
```

It rebuilds the bridge, copies the web game into the Xcode project and then runs
`scripts/configure-ios.mjs`, which writes the settings into the Xcode project. Do not edit
`ios/App/App/Info.plist`, the build settings or the icon files by hand, in Xcode or otherwise:
the next `npm run sync` puts back what `app.config.json` says. (The one thing it leaves alone
is the signing team picked in Xcode.)

`app.config.json`, field by field:

| Field | What it is | Where it ends up |
|---|---|---|
| `appId` | The bundle id: the app's permanent technical name, such as `com.yourname.firstcome`. It cannot be changed once a build has been uploaded. | Xcode build settings |
| `appName` | The name under the icon on the home screen. Keep it short (about 12 characters) or iOS cuts it off. The longer App Store name is set in App Store Connect, not here. | `Info.plist` |
| `version` | The version people see, such as `1.0.0`. Raise it for every App Store release. | Xcode build settings |
| `build` | A whole number that must go up with every upload of the same version. The TestFlight workflow supplies its own number; this one matters when you upload from a Mac. | Xcode build settings |
| `webDir` | Where the web game is, relative to this folder. | Capacitor, the bridge build |
| `admob.testing` | `true`: only Google's demo adverts are requested, whatever ids are filled in. Must be `false` in the build you release. | The bridge |
| `admob.ios.appId` | The AdMob app id (it has a `~` in it). | `Info.plist` |
| `admob.ios.banner`, `.interstitial`, `.rewarded` | The three ad unit ids (each has a `/` in it). | The bridge |
| `iap.removeAdsProductId` | The product id of the Remove Ads purchase, exactly as typed into App Store Connect. | The bridge, the StoreKit test file |
| `trackingUsageDescription` | The sentence iOS shows in its "Allow ... to track" prompt. Say honestly what tracking is for. | `Info.plist` |
| `appleTeamId` (optional) | Your 10-character Apple team id. Only needed for building on a Mac; see "Building on a Mac". | Xcode build settings |

What the configure script sets without asking, and why:

- iPhone only, portrait only, dark appearance (the game is dark in every colour scheme; this
  keeps the clock and battery in the status bar readable).
- `ITSAppUsesNonExemptEncryption = false`: see step 15.
- The SKAdNetwork list from `resources/skadnetwork-ids.json`: see "Keeping things current".
- A privacy manifest (`ios/App/App/PrivacyInfo.xcprivacy`) declaring the one "required reason"
  API the app's own code uses: UserDefaults, through the storage plugin that keeps the saved
  game, reason CA92.1. Google's advert SDKs carry their own manifests.
- A shared Xcode scheme and `ios/App/Products.storekit`, so the purchase can be tried in the
  simulator: see "Trying the purchase without App Store Connect".

## What you need

- An **Apple Developer Program** membership (step 1). Nothing can be uploaded without it.
- A **Google AdMob** account (step 5). Free.
- Either **GitHub Actions** (the two workflows in `ci/` do the building on GitHub's Macs, so
  you need no Mac of your own) or **a Mac with Xcode 26 or later**. Since 28 April 2026 Apple
  only accepts uploads built with Xcode 26 or later.
- **Node.js 22.18 or later** wherever you run `npm run sync`.
- A real **iPhone** for testing before release. Strongly advised: adverts, the tracking prompt
  and purchases behave differently on a real phone than anywhere else.

---

## Part A: accounts and names

### 1. Join the Apple Developer Program

1. Go to <https://developer.apple.com/programs/enroll/> and enrol. It costs 99 USD per
   membership year (Apple shows the local price while you enrol).
2. Choose how to enrol:
   - **Individual**: needs an Apple Account with two-factor authentication. Your legal name is
     shown on the App Store as the seller.
   - **Organisation**: the company name is shown as the seller. Apple requires a D-U-N-S
     number for the company and a work email address on the company's domain.
3. Wait for Apple to confirm. How long this takes varies and needs checking; individual
   enrolments are usually quick, organisations slower.

### 2. Sign the agreements and enter tax and banking details

In App Store Connect (<https://appstoreconnect.apple.com>), in the Business section (it has
also been called "Agreements, Tax, and Banking"):

1. Accept the **Paid Apps Agreement** and add a bank account and the tax forms it asks for.
   The app is free, but the Remove Ads purchase is a sale: until this agreement is active the
   purchase cannot be sold and will not load in the app.
2. Declare your **trader status** for the EU Digital Services Act. Someone who publishes an
   app to earn money is normally a trader. Traders must give an address, phone number and
   email address, which Apple verifies and shows on the app's page in EU countries. Without a
   declaration the app is not offered in the EU.
3. Consider the **App Store Small Business Program**
   (<https://developer.apple.com/app-store/small-business-program/>). It lowers Apple's
   commission on the purchase to 15%. Developers new to the App Store qualify, but you have to
   apply; it is not automatic.

### 3. Choose the names, then create the app record

Two names and one id need deciding. The bundle id is permanent, so take a minute over it.

1. **Bundle id** (`appId`): reverse-domain style, lower case, for example
   `com.yourname.firstcome`. Letters, digits, hyphens and dots only.
2. **Home-screen name** (`appName`): for example `First Come`.
3. **App Store name**: up to 30 characters, and it must not already be taken on the App Store.
   You only find out by trying, when you create the app record (point 5 below).
4. Register the bundle id: <https://developer.apple.com/account> > Certificates, Identifiers &
   Profiles > Identifiers > "+" > App IDs > App. Enter a description and the bundle id as an
   "Explicit" id. Leave the capabilities as they are (In-App Purchase is always on).
5. Create the app record: App Store Connect > Apps > "+" > New App. Platform iOS, the App
   Store name, primary language, the bundle id from the list, and an SKU (any code of your own,
   never shown to anyone).
6. Put `appId` and `appName` into `app.config.json`, run `npm run sync`, commit.

### 4. Supply the artwork

Replace the two placeholder files, keeping the file names, then run `npm run sync`:

- `resources/icon-1024.png`: 1024 x 1024 pixels, square corners (iOS rounds them), **no
  transparency**. The script refuses an icon with an alpha channel, because App Store Connect
  rejects the upload otherwise.
- `resources/splash-2732.png`: 2732 x 2732 pixels. It is shown while the app starts, scaled
  to fill the screen and cropped at the sides, so keep anything important in the middle
  1200 x 1200 pixels.

---

## Part B: adverts

### 5. Create the AdMob account, the app and three ad units

1. Sign up at <https://admob.google.com> and complete the payment profile it asks for. AdMob
   verifies your identity and address before it pays out; the details need checking in AdMob.
2. Apps > Add app > iOS. Answer "No" to whether the app is on the App Store yet, and give it
   a name. AdMob shows an **app id** like `ca-app-pub-1234567890123456~1234567890`.
3. In that app, Ad units > Add ad unit, three times: **Banner**, **Interstitial**,
   **Rewarded**. (For Rewarded, the reward amount and name do not matter; the game decides
   what the player gets.) Each gives an **ad unit id** like
   `ca-app-pub-1234567890123456/1234567890`.
4. Paste the four ids into `app.config.json` under `admob.ios` (`appId`, `banner`,
   `interstitial`, `rewarded`). Leave `"testing": true` for now. Run `npm run sync`, commit.

While `testing` is `true` the app asks for Google's demo adverts even though your real ids
are filled in. That is deliberate: tapping your own live adverts, or letting testers do it,
is against AdMob's rules and can get the account suspended.

### 6. Publish the privacy messages in AdMob

AdMob > Privacy & messaging. The app already contains Google's consent software (the User
Messaging Platform); these messages are what it shows.

1. **European regulations (GDPR) message: required.** Create it, select this app, choose the
   languages, decide whether to show a "Do not consent" button on the first page, add your
   privacy policy URL (the game's `privacy.html` on the web) and **Publish**. It is shown to
   people in the EEA, the UK and Switzerland before any advert is requested. In those
   countries the game also shows a "Privacy choices" row in its settings so people can change
   their answer.
   If no message is published, the release build may show no adverts at all, anywhere: the
   app only requests adverts after Google's consent check has answered. Whether that check
   succeeds without a published message has not been tried and needs checking on a device.
2. **IDFA explainer message: optional.** It shows a screen of your own wording just before
   the iOS "Allow ... to track" prompt. The app shows the iOS prompt by itself in any case,
   with the sentence from `trackingUsageDescription`. How the two behave together has not
   been tried on a device.
3. **US state regulations message: optional**, and whether you want one needs checking
   against AdMob's own guidance.

### 7. Publish app-ads.txt

Advertisers use this small file to confirm that you are allowed to sell advert space in the
app. Without it some will not bid, which lowers what the adverts earn.

1. AdMob > Apps > View all apps > app-ads.txt tab > "How to set up app-ads.txt". Copy the
   line it gives you. It looks like `google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0`.
2. Publish a plain text file containing that line at the **root** of your website:
   `https://your-domain/app-ads.txt`. AdMob only looks at the domain, never in a sub-folder.
3. In App Store Connect, put that website into the app's **Marketing URL** field. That is
   where AdMob learns which domain to look at.
4. After the app is live, AdMob finds and checks the file by itself. Allow a day or more,
   then look at the app-ads.txt tab again.

A trap: if the website is a GitHub Pages *project* site (`https://NAME.github.io/REPOSITORY/`),
the root of that domain belongs to a different repository, the one called `NAME.github.io`.
The file has to go there, or onto a domain of your own. Google suggests Firebase Hosting for
people with no suitable site.

---

## Part C: the purchase

### 8. Create the Remove Ads in-app purchase

1. App Store Connect > Apps > your app > Monetization > In-App Purchases > "+".
2. Choose **Non-Consumable** (bought once, kept for ever, restorable on a new phone).
3. Reference name: `Remove Ads`. Product ID: exactly the value of `iap.removeAdsProductId` in
   `app.config.json`, which is `remove_ads` today. If App Store Connect says the id is not
   available, pick another (for example `com.yourname.firstcome.remove_ads`), put the same
   text into `app.config.json`, and run `npm run sync`.
4. Open the new purchase and fill in everything it lists as missing: the price, at least one
   localisation (the display name and description people see on the payment sheet), and the
   review screenshot (a screenshot of the game's Remove Ads panel is the usual choice).
   Its status should become "Ready to Submit".
5. The first in-app purchase has to be reviewed together with an app version. In step 16,
   on the version's page, add it under "In-App Purchases and Subscriptions" before submitting.
   If you forget, the purchase stays unapproved and the Remove Ads button finds nothing.

Changes to a purchase can take up to an hour to reach the test environment.

---

## Part D: building and testing

### 9. Prove that the app builds

Either use the build workflow ("The two CI workflows" below) or a Mac ("Building on a Mac").
The first successful build is the moment the unproven parts of this project get proved, so
do this early, while waiting for Apple and Google to approve accounts.

### 10. Upload a test build to TestFlight

1. Set up the secrets and run the TestFlight workflow (below), or archive and upload from a
   Mac. For this step `admob.testing` stays `true`.
2. Some minutes after the upload the build appears in App Store Connect > your app >
   TestFlight. Apple sends an email if it finds a problem with the build.
3. Add yourself under Internal Testing (people in your App Store Connect team; no review
   needed), install the TestFlight app on your iPhone and install the build from there.
   Testers outside the team (External Testing) need a short Beta App Review of the first build.
4. Try everything on the phone. None of this has been tried on a real device yet:
   - The game starts and the launch image gives way to the first screen.
   - iOS asks "Allow ... to track your activity" once, with your sentence in it.
   - A demo banner appears at the bottom and does not cover any part of the game.
   - A full-screen demo advert appears now and then between levels and the game carries on
     afterwards. A rewarded video gives its reward; closing it early gives nothing.
   - Remove Ads: the price appears, the purchase goes through (purchases in TestFlight builds
     are not charged), the adverts disappear and stay gone after restarting the app.
   - Delete the app, install it again, use "Restore purchases": the adverts are gone again.
   - Progress is still there after closing and reopening the app.
   - Sharing a result opens the iOS share sheet; the privacy and support links open.
   - With the phone in aeroplane mode the game still starts and plays.

### 11. Switch to real adverts and upload the release build

1. In `app.config.json` set `"testing": false`. Check the four AdMob ids once more.
2. Raise `version` if a build with this version has already been released.
3. Run `npm run sync`. It prints a warning if demo ids are still in place. Commit.
4. Upload again (step 10). This is the build you will submit.
5. On your own phone, do not tap the adverts in this build. To look at it safely, register
   the phone as a test device in AdMob (Settings > Test devices), which makes AdMob serve
   test adverts to that phone only.

---

## Part E: the App Store listing and review

All of this is in App Store Connect > Apps > your app.

### 12. Fill in the listing

- **Screenshots.** At least 1 and at most 10, as .png, .jpg or .jpeg, without transparency.
  For an iPhone-only app no iPad screenshots are asked for. Apple's specification page
  (<https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications>)
  names the "iPhone with Dynamic Island (medium display)" size as the required one, while its
  table still treats the large display as the main size. Portrait sizes it accepts:
  - large display: 1320 x 2868, 1290 x 2796 or 1260 x 2736 pixels;
  - medium display: 1206 x 2622 or 1179 x 2556 pixels.

  App Store Connect scales screenshots down for smaller phones, and its upload page shows
  which size it insists on. Making one set at 1320 x 2868 and one at 1206 x 2622 covers both
  readings. Without a Mac, take them on a real iPhone of the right model, or open the web
  version of the game in a desktop browser's phone preview at 440 x 956 (or 402 x 874) with a
  device pixel ratio of 3, which gives exactly those pixel sizes. Screenshots must show the
  real game.
- **Name** (30 characters), **subtitle** (30), **keywords** (100 characters in total, comma
  separated), **description**, **promotional text** (optional).
- **Support URL** (required): the game's `support.html` on the web.
- **Marketing URL**: the website that carries app-ads.txt (step 7).
- **Privacy Policy URL** (required): the game's `privacy.html` on the web.
- **Category**: Games, with Puzzle as the sub-category.
- **Price**: Free. **Availability**: the countries you want.
- Do **not** put the app in the Kids category or mark it as made for children. Apple's rules
  for children's apps do not allow this kind of third-party advertising.

### 13. Answer the App Privacy questions

The game itself collects nothing: no accounts, no analytics, progress stays on the phone.
The answers come from the advert software. Google lists what its Mobile Ads SDK may collect
at <https://developers.google.com/admob/ios/privacy/data-disclosure>. Read that page while
answering, because Google updates it. As read for this guide, it leads to:

1. "Do you or your third-party partners collect data from this app?" **Yes.**
2. Data types to tick:

   | Apple's category | Data type | What Google's page says |
   |---|---|---|
   | Location | Coarse Location | derived from the IP address |
   | Identifiers | Device ID | the advertising identifier and similar device identifiers |
   | Usage Data | Product Interaction | app launches, taps, video views |
   | Usage Data | Advertising Data | which adverts the person has seen |
   | Diagnostics | Crash Data | crash logs |
   | Diagnostics | Performance Data | launch time, hang rate, energy use |

3. For each type, the purposes: **Third-Party Advertising** and **Analytics**. Google's page
   says both for most of them.
4. "Is this data used to track the user?" **Yes** for at least Device ID and Advertising Data.
   The app shows the tracking prompt precisely because the advert software may link what it
   collects with data from other companies' apps.
5. "Is this data linked to the user's identity?" Google's page does not answer in Apple's
   words. Answering "Yes" for the types above is the cautious choice and needs checking
   against Apple's definitions shown next to the question.

Do not tick Purchases: Apple handles the payment, and neither the game nor Google receives
the purchase history.

### 14. Answer the age rating questions

App Information > Age Rating. Apple works the rating out from the answers.

- **Advertising** (under Capabilities): **Yes.** Per Apple's table this still gives 4+.
- **Unrestricted Web Access**: **No.** The in-app browser only opens the game's own privacy
  and support pages. (Answering Yes would make the app 16+.)
- User-Generated Content, Social Media, Messaging and Chat: No.
- Parental Controls, Age Assurance: No.
- Every content question (violence, gambling, contests, loot boxes, mature themes and so on):
  None / No. The Daily puzzle is not a contest in Apple's sense: players do not compete with
  each other for rankings or rewards.

Expected result: **4+**. If App Store Connect shows something else, re-read the answers.

### 15. Export compliance

Apple asks whether an app uses encryption. This app uses only what is built into iOS (HTTPS
connections made by the system), which is exempt. The configure script declares that in
`Info.plist` (`ITSAppUsesNonExemptEncryption = false`), so App Store Connect does not ask
again for every build. If code that does its own encryption is ever added, this has to be
reconsidered.

### 16. Submit for review

1. On the version's page, choose the build from step 11.
2. Under "In-App Purchases and Subscriptions", add Remove Ads (first submission only).
3. Fill in App Review Information: your contact details, and a note such as "No account or
   sign-in is needed. The Remove Ads purchase is reached from the home screen and from
   Settings."
4. Choose whether the app goes live automatically after approval or when you press a button.
5. Submit.

**How long review takes.** Apple's own statement: App Review typically reviews at least 50%
of submissions in less than 24 hours and 90% in less than 48 hours. A first version with a
first in-app purchase can sit at the slower end, and an incomplete submission is delayed. If
the app is rejected, App Store Connect shows the reason and lets you reply or upload a fixed
build; a resubmission is reviewed again.

Things reviewers commonly pick up in an app like this one:

- The in-app purchase was not attached to the version, or does not load.
- The listing or screenshots still show placeholder names or art.
- The privacy answers do not match what the app does (it shows a tracking prompt, so the
  answers must say that data is used for tracking).
- Reviewers may run an iPhone app on an iPad, where it appears in an iPhone-sized window.
  Nobody has tried this app there.

### 17. After release

- In AdMob, link the app to its App Store listing (in the app's settings in AdMob; the exact
  menu needs checking). AdMob then reviews the app, and adverts may be limited until that is
  done. Check the app's status in AdMob for a few days.
- Check the app-ads.txt tab in AdMob (step 7).
- For an update: raise `version` in `app.config.json`, `npm run sync`, commit, upload, then
  create the new version in App Store Connect and submit it.

---

## The two CI workflows

They are installed in `.github/workflows/` at the top of the repository, with the
placeholders already filled in for this repository. The templates they came from are in `ci/`.
Both run on GitHub's Mac runners. On private repositories Mac minutes are billed at a higher
rate than Linux minutes; the current rates need checking on GitHub's billing page.

Both pick the newest Xcode installed on the runner that is not a beta, using
`scripts/select-xcode.sh`, so they never name a version GitHub may have removed. Today
`macos-latest` is a macOS 26 runner with Xcode 26.0.1 to 26.6.

### ios-build.yml: does it still compile?

Runs on every push that touches this folder or the web game, or by hand. It runs the tests,
`npm run sync`, downloads the Swift packages and builds the app for the iPhone simulator
without signing. It needs no secrets. A red run means the last change broke the app.

### ios-testflight.yml: build, sign, upload

Runs only by hand: repository > Actions > "iOS TestFlight" > Run workflow. **It has never
been run.** It needs four repository secrets (Settings > Secrets and variables > Actions):

| Secret | What to put in |
|---|---|
| `APP_STORE_CONNECT_KEY_ID` | The Key ID of an App Store Connect API key |
| `APP_STORE_CONNECT_ISSUER_ID` | The Issuer ID shown above the list of keys |
| `APP_STORE_CONNECT_KEY_P8_BASE64` | The downloaded `.p8` key file, base64-encoded |
| `APPLE_TEAM_ID` | Your Team ID: developer.apple.com > Account > Membership details |

To get the key:

1. App Store Connect > Users and Access > Integrations > App Store Connect API. The first
   time, the Account Holder has to click Request Access and accept the terms.
2. Team Keys > Generate API Key (or "+"). Give it a name and the **Admin** role. Admin is
   certain to be allowed to create the signing certificate and profile; whether App Manager
   is enough needs checking.
3. Download the `.p8` file. It can be downloaded once only. Note the Key ID and Issuer ID.
4. Encode the file and copy the output into the secret:
   - macOS: `base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy`
   - Linux: `base64 -w0 AuthKey_XXXXXXXXXX.p8`
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXXXXXXXX.p8"))`
5. Keep the `.p8` file somewhere safe and out of the repository. Anyone who has it can act on
   your Apple account. If it leaks, revoke the key in App Store Connect.

What the workflow does: `npm run sync`, then `xcodebuild archive` and `xcodebuild
-exportArchive` with automatic signing, signed in with the API key. Apple creates and keeps
the certificates ("cloud-managed signing"); none is stored in the repository. The build
number is the workflow's run counter, so each run uploads a higher number than the last. If
you have also uploaded from a Mac with a higher number, type a number into the
"build_number" box when starting the run.

If the first run fails, the likely causes, in rough order:

- **API access was never requested**, or the key's role is too low (use Admin).
- **No app record or bundle id** for the `appId` in `app.config.json` (step 3). The workflow
  stops early if `appId` is still `com.example.…`.
- **"Your team has no devices"**: Apple may refuse to create a development profile for a team
  that has never registered a device. Register your iPhone at developer.apple.com >
  Certificates, Identifiers & Profiles > Devices. Whether this is needed with an API key
  needs checking; it is a known stumbling block. The comment above the Archive step in the
  workflow file describes a second, equally untested, way round it.
- **An agreement is waiting**: Apple blocks uploads until the Account Holder accepts an
  updated agreement on developer.apple.com.
- **The build number was used before**: run it again, or enter a higher number.
- **Xcode too old**: Apple raises the minimum each spring. If uploads are refused for the SDK
  version, `macos-latest` is lagging: change `runs-on` to a newer macOS runner label from
  GitHub's list.

## Building on a Mac

The alternative to the workflows. You need Xcode 26 or later and Node.js 22.18 or later.

1. In this folder: `npm ci`, then `npm run sync`. Always run `npm run sync` before opening
   Xcode: the web game and two generated files are not committed and appear only then.
2. Open the project: `npx cap open ios`, or open `ios/App/App.xcodeproj`.
3. Signing: put your team id into `app.config.json` as `"appleTeamId": "XXXXXXXXXX"` and run
   `npm run sync`. (Choosing the team in Xcode under Signing & Capabilities also works, and
   the script keeps that choice.) You must be signed in to Xcode with your Apple Account:
   Xcode > Settings > Accounts.
4. To try it: choose an iPhone simulator at the top and press Run.
5. To upload: raise `build` in `app.config.json` and run `npm run sync`. In Xcode choose
   "Any iOS Device" as the destination, then Product > Archive. When the Organizer window
   opens: Distribute App > App Store Connect > Upload.
6. The first time Xcode downloads the Swift packages it writes
   `ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
   Commit that file: it pins the exact package versions for everyone else.

If Xcode changes `project.pbxproj` in a way the configure script cannot reproduce exactly,
`npm run sync` stops and says so rather than risk damaging the project. Its message explains
the next step (`--allow-reformat`, then review the change).

## Trying the purchase without App Store Connect

`ios/App/Products.storekit` describes a pretend Remove Ads product (2.99, United States
store). The shared "App" scheme tells Xcode to use it whenever the app is **run from Xcode**,
on a simulator or a phone, so the whole purchase flow can be tried before step 8 is done.
In Xcode, Debug > StoreKit > Manage Transactions lists the pretend purchases and lets you
delete them to start again.

It affects nothing else: TestFlight and App Store builds are archives, which talk to Apple's
real store. To make a run from Xcode use Apple's sandbox instead, choose Product > Scheme >
Edit Scheme > Run > Options > StoreKit Configuration > None. The next `npm run sync` turns
the file back on.

The file is written in an older, widely readable version of Apple's format; Xcode may offer
to upgrade it when you edit it there. It has not been opened in Xcode yet.

## Keeping things current

- **SKAdNetwork identifiers.** `resources/skadnetwork-ids.json` holds the 50 identifiers
  Google publishes for AdMob (its own and its buying partners'), downloaded from
  <https://developers.google.com/admob/ios/quick-start> on 13 November 2026. Nothing in the
  list was typed by hand. Google changes it now and then:
  `npm run update:skadnetwork`, then `npm run sync`, then commit. Once or twice a year is
  enough.
- **Adding a Capacitor plugin.** After `npm install`, run `npm run sync`. Then check whether
  the plugin uses one of Apple's "required reason" APIs (UserDefaults, file timestamps, boot
  time, disk space, active keyboards) without shipping its own `PrivacyInfo.xcprivacy`; if
  so, add the category to `PRIVACY_MANIFEST_CONTENT` in `scripts/configure-ios.mjs`.
- **Xcode.** Apple raises the minimum Xcode for uploads every spring. The workflows follow
  GitHub's runners; on a Mac, update Xcode.

## Commands

| Command | What it does |
|---|---|
| `npm run sync` | Bridge build, `cap sync ios`, then `scripts/configure-ios.mjs`. The command to run after any change. |
| `npm run configure:ios` | Only the last part: apply `app.config.json` and `resources/` to `ios/`. |
| `npm run configure:ios -- --check` | Changes nothing; fails if `ios/` is out of step with `app.config.json`. |
| `npm run update:skadnetwork` | Refresh the SKAdNetwork list from Google's page. |
| `npm test` | All tests, including the ones for the scripts above. Runs on Linux, macOS and in CI. |
| `npm run typecheck` | Type-check the bridge. |
| `python3 scripts/make-placeholder-art.py` | Recreate the placeholder icon and launch image (needs Pillow). |

## What has not been verified

Checked on Linux: `npm run sync` runs from start to finish and a second run changes nothing;
`Info.plist` and the privacy manifest parse and hold the expected values; the edited
`project.pbxproj` parses again and is written back byte for byte; the workflow files are
valid YAML and their shell steps were exercised with stand-ins for Apple's tools.

Not checked, because it needs a Mac, an Apple account or a phone:

- That Xcode opens the project, resolves the Swift packages and builds it. No build of any
  kind has been made.
- Both workflows on a real GitHub runner. The TestFlight workflow in particular: signing with
  an API key, the upload, and whether a brand-new team needs a registered device.
- That Xcode accepts `Products.storekit` and the shared scheme, and that the pretend purchase
  works in the simulator.
- That App Store Connect accepts the build: the privacy manifest, the icon, the
  `Info.plist` keys.
- Everything in the checklist of step 10: adverts, consent and tracking prompts, the purchase
  and restore, on a real iPhone.
- The app in an iPhone-sized window on an iPad.
