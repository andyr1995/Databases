# The Android app: from this repository to Google Play

This folder also turns the web game into an Android app. The Android project is in `android/`:
the same Capacitor shell as on iPhone (a full-screen web view showing the game) and the same
bridge to adverts, the Remove Ads purchase and other phone features.

This guide is the counterpart of [SHIPPING.md](SHIPPING.md), which covers the iPhone app. Where
a step is the same for both (most of AdMob), this guide says so and points there. Read "Where
things stand" and "The one rule" first. The numbered steps after that go from no Google account
at all to a published app, in the order that causes the least waiting.

How far to trust this guide:

- Requirements that change (the target Android version, 16 KB memory pages, the billing
  library deadlines, the registration fee, the testing rule for new personal accounts, what
  Google shows publicly about a developer, listing sizes, what AdMob's software collects, the
  app-ads.txt rules, developer verification, what GitHub's runners have installed) were read
  from Google's, Android's and GitHub's own pages on 14 November 2026.
- Menu paths in Play Console are given as Google's help pages wrote them on that day where
  this guide found them there, and from general knowledge of the site otherwise. Play Console
  is reorganised often; if a menu is not where this guide says, use the search box at the top
  of Play Console and type the name of the thing.
- A line that says "needs checking" is something nobody here could confirm. Look it up
  before relying on it.

## Where things stand

- **The app builds.** On 14 November 2026 the project was built on a Linux machine (Java 21,
  Android SDK 36): a debug APK, an unsigned release bundle, and a release bundle signed with a
  throw-away key. All three were opened with Android's own tools and held what they should.
  **Nothing has run on a phone or an emulator yet**, nothing has been uploaded to Google
  Play, and the two workflows have not yet run on GitHub. "What has not been verified" at the
  end lists exactly what is unproven.
- **The app's identity is set but yours to change.** `app.config.json` calls the app
  `First Come` with the package name `app.firstcome.puzzle` (the field `appId`, which is also
  the iPhone bundle id; an optional second field, `androidAppId`, gives Android a name of its
  own). A package name is permanent from the moment you create the app in Play Console, so
  decide on it in step 3.
- **The adverts are Google's demo adverts.** `admob.testing` is `true` and the ids under
  `admob.android` are Google's public sample ids. A build made now earns nothing.
- **The icon and launch screen are real**, drawn by `scripts/make-art.mjs` (`npm run art`).

## The one rule

The same rule as on iPhone. Everything about the app that can change lives in two places:

- `app.config.json`: name, package name, version, AdMob ids, the product id of the purchase;
- `resources/android/`: the launcher icons and three colours (`colors.json`).

After changing either, run this in this folder and commit everything it changes:

```
npm run sync
```

It first checks that `app.config.json` is acceptable to both platforms, and stops before it
has written anything if either refuses (so a value that only Android or only iPhone rejects
never leaves one project changed and the other not). Then it rebuilds the bridge, copies the
web game into both native projects, and runs `scripts/configure-ios.mjs` and
`scripts/configure-android.mjs`, which write the settings into the Xcode project and the
Android project. Do not edit the package name, the version, the manifest entries listed below,
the icon files or the theme colours by hand, in Android Studio or otherwise: the next
`npm run sync` puts back what `app.config.json` says. Things you add yourself (another
permission, another string, a dependency) are left alone.

The fields of `app.config.json` that the Android app uses:

| Field | What it is | Where it ends up |
|---|---|---|
| `appId` | The package name: the app's permanent technical name, such as `com.yourname.firstcome`. It is the iPhone bundle id as well. Use only letters, digits and dots, and the one id is valid in both stores (Android refuses hyphens, Apple refuses underscores). | `android/app/build.gradle` (twice), the folder of `MainActivity.java`, `strings.xml` |
| `androidAppId` | Optional, and normally absent. The Android package name when it cannot be the same as `appId`: for an iPhone app that already exists under a bundle id with a hyphen in it. When present, Android uses it in place of `appId` everywhere; iPhone ignores it. | The same places as `appId` |
| `appName` | The name under the icon. Keep it short (about 12 characters) or launchers cut it off. The longer name on Google Play is set in Play Console, not here. | `strings.xml` |
| `version` | The version people see, such as `1.0.0` (Android calls it the version name). Raise it for every release. | `android/app/build.gradle` |
| `build` | The version code: a whole number that must go up with every upload to Google Play. The release workflow supplies its own number; this one matters when you build on your own computer. | `android/app/build.gradle` |
| `webDir` | Where the web game is, relative to this folder. | Capacitor, the bridge build |
| `admob.testing` | `true`: only Google's demo adverts are requested, whatever ids are filled in. Must be `false` in the build you release. Shared with iPhone. | The bridge |
| `admob.android.appId` | The AdMob app id of the Android app (it has a `~` in it). | `AndroidManifest.xml` |
| `admob.android.banner`, `.interstitial`, `.rewarded` | The three ad unit ids of the Android app (each has a `/` in it). | The bridge |
| `iap.removeAdsProductId` | The product id of the Remove Ads purchase. One value for both stores, so it has to be typed the same way into App Store Connect and Play Console. | The bridge |

What the configure script sets without asking, and why:

- **Portrait only**, and the app is marked as a **game**. On tablets and unfolded phones,
  Android 16 ignores an app's portrait lock unless the app is a game.
- **No unencrypted (http) traffic.**
- **The launch screen**: the background colour and the emblem from `resources/android`, shown
  through Android's own splash screen on every Android version. How long it stays is decided
  in `capacitor.config.ts`: until the game has drawn its first screen, or 5 seconds.
- **Edge to edge, with transparent system bars and light symbols.** The game is drawn under
  the status bar and the navigation bar and keeps its own content clear of them; the symbols
  are light because the game is dark whatever the phone's theme is. Android 15 and later draw
  every app like this; on Android 14 and earlier the app has to ask, and
  `MainActivity.java` (which the script writes) does. Capacitor's bar handling and the
  position of the advert banner are built on it: without it, on Android 14 and earlier, the
  game leaves an empty strip above the banner. If you ever need code of your own in
  `MainActivity.java`, delete the comment at its top as it says there; the script then keeps
  your file, and stops with an explanation if the edge-to-edge call has gone.
- **Release signing from outside the repository** (`android/app/release.gradle`): see step 6.
- It **deletes the placeholder art** of Capacitor's template (Capacitor's own launch image and
  the stock Android robot), which would otherwise ship inside the app.

What it does not set, because the libraries bring it themselves (checked in the built app):
the advertising-id permission (`com.google.android.gms.permission.AD_ID`, from Google's advert
library), the billing permission (`com.android.vending.BILLING`, from the Play Billing
library), internet access and vibration.

## What you need

- A **Google Play Console developer account** (step 1). One-off fee of 25 US dollars.
- A **Google AdMob** account. The same one as for the iPhone app (SHIPPING.md step 5).
- Either **GitHub Actions** (the two workflows in `ci/` do the building on GitHub's Linux
  machines) or **a computer with Java 21 and the Android SDK** (Windows, macOS or Linux;
  installing Android Studio gives you both).
- **Node.js 22.18 or later** wherever you run `npm run sync`.
- A real **Android phone**. Google requires one to verify a personal developer account, and
  adverts, the consent message and purchases cannot be judged anywhere else.
- If your developer account is a personal one: **at least 12 people with Android phones** who
  will keep a test version installed for two weeks (step 2). Start asking now.

---

## Part A: the account, the name and the app

### 1. Open a Google Play Console developer account

1. Go to <https://play.google.com/console/signup>. You must be at least 18. The registration
   fee is 25 US dollars, paid once. Google Play does not accept prepaid cards for it.
2. Choose the account type:
   - **Personal**: for an individual. Your legal name and country are shown on Google Play.
     **If you earn money on Google Play (the Remove Ads purchase counts), Google shows your
     full address too.** Personal accounts also have the testing requirement of step 2.
   - **Organisation**: for a company. Google requires a D-U-N-S number (free from Dun &
     Bradstreet, but it can take up to 28 days to get one), and shows the organisation's name,
     address, phone number and D-U-N-S number. Organisation accounts do not have the testing
     requirement.
3. Complete the checks Google asks for: your identity (a government ID, and Google may ask for
   a credit card in the same name), a contact email address and phone number, each confirmed
   with a one-time code, and, for a personal account, **access to a real Android phone**,
   proved by signing in to the Play Console app on that phone. Nothing can be published before
   these are done. How long Google takes to verify an identity needs checking; allow some days.
4. Google is also introducing "developer verification" for all of Android. With a Play Console
   account you need do nothing more for an app published through Google Play: the app is
   registered automatically when it uses Play App Signing, which this guide sets up in step 6.

### 2. Plan for the closed test (personal accounts only)

Google does not let a personal account created after 13 November 2023 publish straight away.
Before you can apply for production access you must run a **closed test with at least 12
testers who stay opted in for at least 14 days without a break**. A tester who leaves and
comes back starts counting again. After the 14 days you answer some questions about the test,
and Google reviews the application; it says this usually takes seven days or less.

So the calendar for a first release is roughly: account checks, then two weeks of closed
testing, then up to a week for production access, then the review of the release itself. The
two weeks cannot be shortened. What you can do is have the 12 people lined up, and get the app
into closed testing (step 18) as early as it is presentable. Each tester needs a Google
account and an Android phone, and must install the app through the link you send.

### 3. Choose the package name and create the app

1. **Decide the package name** (`appId`): reverse-domain style, lower case, for example
   `com.yourname.firstcome`. Letters, digits and dots only; every part starts with a letter.
   Google's words: "Package names for app files are unique and permanent, so name them
   carefully", and they "can't be deleted or re-used". If the iPhone app already exists under
   an id, use the same one. The one case where that is impossible is an iPhone bundle id with
   a hyphen in it, which Android cannot take: leave `appId` as it is and add a second field
   for Android, for example `"androidAppId": "com.your_name.firstcome"`. (`npm run sync`
   stops and proposes that very line if it meets such an id.)
2. Put it into `app.config.json` (with `appName` if you are changing that too), run
   `npm run sync`, commit. The script renames everything in the Android project that carries
   the package name, including the folder of `MainActivity.java`.
3. In Play Console click **Create app** and fill in:
   - the app name as it should appear on Google Play (up to 30 characters; `store/listing.md`
     has a suggestion). It can be changed later;
   - the package name, exactly as in `app.config.json` (`androidAppId` if you added that
     field, otherwise `appId`). `npm run sync` prints it in its last line;
   - the default language;
   - **Game**, and **Free**. (The app is free; Remove Ads is a purchase inside it.)
   - an email address that users can write to. It is shown on the listing;
   - the declarations: the Developer Program Policies, US export laws, and the Play App
     Signing terms.

### 4. Set up the payments profile

The app is free, but Remove Ads is a sale. Until Play Console has a payments profile (your
bank details and tax information), the purchase cannot be created and will not load in the
app. Where Play Console asks for it needs checking: look under **Monetize with Play**, or
type "payments profile" into Play Console's search box.

Google keeps a service fee from every sale. The rates were changed in 2026 and now depend on
the buyer's country. As Google's page "Service fees" stood on 14 November 2026: for buyers in
the United States, the European Economic Area, the United Kingdom, Australia and Japan, a
one-time purchase such as Remove Ads costs 20% plus a 5% billing fee when the buyer installed
the app after the new rates came in (more for earlier installs, which a new app does not
have; less for developers in two of Google's programmes). For buyers everywhere else the
older rates still apply "until the announced updated service fees are rolled out globally":
30%, or, for developers enrolled in the 15% tier, 15% on the first million US dollars a
year. That enrolment is not automatic. Read the page itself before counting on a number:
<https://support.google.com/googleplay/android-developer/answer/112622>.

### 5. Check the artwork

`npm run art` has already drawn everything from one design. There is nothing to do here unless
you want different art:

- `resources/android/mipmap-*/`: the launcher icon in five sizes, each as a square icon, a
  round icon, and the emblem alone on a transparent background (`ic_launcher_foreground.png`,
  the top layer of the "adaptive" icon that Android 8 and later cut into whatever shape the
  phone uses). The script refuses a foreground without transparency or an icon of the wrong
  size.
- `resources/android/colors.json`: the colour behind the emblem in the icon, the launch
  screen's background, and the colour behind the system bars.
- `resources/play/`: the two pictures the Play listing needs (step 16).

After changing any of it: `npm run sync`, commit.

---

## Part B: signing

### 6. Create the upload key

Google Play only accepts an app bundle that is signed. With **Play App Signing**, which every
new app uses, there are two keys:

- the **app signing key**, which Google creates and keeps, and uses to sign what phones
  download;
- the **upload key**, which you create and keep, and which signs what you upload, so that
  Google knows the upload is from you. If it is lost or stolen, Google can replace it. That
  is the point of the arrangement.

Create the upload key once, **outside this repository**:

1. On any computer with Java installed, in a folder that is not inside the repository:

   ```
   keytool -genkeypair -v -keystore upload-keystore.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```

   It asks for a password (choose a long one and write it down) and for your name and
   country, and writes the file `upload-keystore.jks`. `upload` is the name of the key inside
   the file (its "alias"). With a current Java the key's own password is the same as the
   file's password.
2. Keep the file and the password somewhere safe and backed up: a password manager that
   stores files is ideal. Never put the file in the repository. (`android/.gitignore` refuses
   `*.jks` and `*.keystore` as a safety net.)
3. The build reads four values, from environment variables or from Gradle properties, and
   from nowhere else:

   | Name | Value |
   |---|---|
   | `ANDROID_KEYSTORE_FILE` | Where the keystore file is: a full path |
   | `ANDROID_KEYSTORE_PASSWORD` | The password you chose |
   | `ANDROID_KEY_ALIAS` | `upload` |
   | `ANDROID_KEY_PASSWORD` | The same password again |

   For GitHub, they go into repository secrets: see "The two CI workflows". For your own
   computer, see "Building on your own computer". With none of them set, a release build is
   simply left unsigned, and debug builds never need them.
4. The first signed bundle you upload to Play Console (step 12) makes this key the app's
   upload key. From then on Play Console refuses bundles signed with any other key.

If the upload key is ever lost: make a new one in the same way, export its certificate with
`keytool -export -rfc -keystore upload-keystore.jks -alias upload -file upload_certificate.pem`,
and in Play Console open the Play app signing page and, in its "Upload key certificate"
section, click "Request upload key reset". Google's help page gave the way there, on 14
November 2026, as **Protected with Play > Play Store protection > Manage Play app signing**;
if the menu has moved again, type "Play app signing" into Play Console's search box.

---

## Part C: adverts

AdMob treats the Android app as a second app in the same account. Steps 5 to 7 of SHIPPING.md
explain the ideas; only the differences are written out here.

### 7. Add the Android app and three ad units in AdMob

1. AdMob > Apps > Add app > **Android**. Answer "No" to whether the app is on Google Play
   yet. AdMob shows an **app id** like `ca-app-pub-1234567890123456~1234567890`. It is a
   different id from the iPhone app's.
2. In that app, create three ad units: **Banner**, **Interstitial**, **Rewarded**, as in
   SHIPPING.md step 5.
3. Paste the four ids into `app.config.json` under `admob.android` (`appId`, `banner`,
   `interstitial`, `rewarded`). Leave `"testing": true` for now. Run `npm run sync`, commit.

The app id ends up in `AndroidManifest.xml`. Google's advert library stops the app at launch
("Missing application ID") when it is absent or mistyped, so the configure script checks its
shape and the build workflow checks that it is inside the built app.

While `testing` is `true` the app asks for Google's demo adverts even though your real ids
are filled in, for the reason given in SHIPPING.md: tapping your own live adverts can get the
AdMob account suspended.

### 8. Publish the consent message for the Android app

AdMob > Privacy & messaging. The European regulations (GDPR) message described in SHIPPING.md
step 6 is needed for the Android app as well: either add the Android app to the message you
made for the iPhone app, or create one for it, and **Publish**. There is no Android
counterpart of the iPhone tracking prompt, so the "IDFA explainer" does not apply.

As on iPhone, the app requests adverts only after Google's consent check has answered, so a
missing message may mean no adverts at all in the release build. That has not been tried.

### 9. app-ads.txt

One file serves both apps: the line AdMob gives you is the same for the whole AdMob account.
If you published `app-ads.txt` for the iPhone app (SHIPPING.md step 7), the file is done.

For Android, AdMob learns which website to look at from the Play listing: Play Console > Grow
users > Store presence > Store settings > **Store listing contact details** > Website. Enter
the website whose root carries the file. AdMob can take up to 24 hours to find and check the
file after the app is live, and as long again to notice a changed website. The GitHub Pages
trap described in SHIPPING.md applies here too.

---

## Part D: building and the first tests

### 10. Prove that the app builds

Either use the build workflow ("The two CI workflows" below) or your own computer ("Building
on your own computer"). Do this early, while Google is checking the account.

### 11. A first look: put the debug APK on a phone

The build workflow keeps a **debug APK** with every run. It is a complete app that installs
without Google Play, meant for exactly this: seeing the game on a real phone before any
account exists.

1. On GitHub: the repository > Actions > "Android build" > the latest run with a green tick >
   **Artifacts** at the bottom > the `.apk` file. You have to be signed in to GitHub. Either
   do this in the phone's browser, or download the file on a computer and send it to the
   phone (a cable, a cloud drive, an email to yourself).
2. On the phone, open the downloaded file. The first time, Android says that the browser (or
   the Files app) is not allowed to install apps and offers its settings: allow it there, go
   back, and tap Install. Google Play Protect may offer to scan the app first; let it.
3. With a cable instead: turn on USB debugging on the phone (Settings > About phone, tap
   "Build number" seven times; then Developer options > USB debugging) and run
   `adb install -r the-file.apk` on the computer. `adb` comes with the Android SDK.
4. **Before installing a newer debug APK, uninstall the old one.** Every run of the workflow
   signs its debug APK with a key made on the spot, and Android refuses to replace an app
   with one signed by a different key ("App not installed"). Uninstalling normally deletes
   the saved game of that test install, but not always: see "Android's backup brings saved
   games back" below.

What to expect from this build: the game, Google's demo adverts, the Back button, sharing and
vibration all work. The consent message appears only once it is published in AdMob (step 8).
The Remove Ads price stays empty until steps 13 and 14 are done; after that the purchase
works in this build too, provided the phone's Google account is one of your licence testers.

About installing from a file in future: on 30 September 2026 Google began to block apps of
unverified developers, at first only in Brazil, Indonesia, Singapore and Thailand and only for
installs from certain app stores. Installing a file you downloaded yourself is not affected
yet; Google says the rule will reach all apps on certified phones during 2027. Google also
says that `adb install` keeps working without any registration. Once the app exists in Play
Console under your verified account this should not concern you, but how a debug build signed
by a throw-away key will be treated then needs checking.

### 12. Upload a signed bundle to internal testing

Internal testing is the quickest track: up to 100 testers you name, no waiting for a review
(Google says an internal test "might not be subject to" the usual reviews), and, in Google's
words, a new bundle "becomes available to testers within minutes".

1. Make the signed bundle: set up the secrets and run the release workflow (below), then
   download the `.aab` file from the run's Artifacts. Or build it on your own computer. For
   this step `admob.testing` stays `true`.
2. Play Console > your app > Test and release > Testing > **Internal testing** > Create new
   release. Play Console shows that releases are signed by Google Play (Play App Signing,
   whose terms you accepted when creating the app); there is nothing to choose. Upload the
   `.aab`, give the release a name, and save and roll it out.
3. On the Testers tab, make a list of email addresses (the Google accounts of the testers,
   yourself first) and copy the link shown there. Open the link on the phone, accept, and
   install the app from Google Play. It can take a while (Google says up to a few hours the
   first time) before the listing is visible to testers.
4. If Play Console refuses the bundle: "version code has already been used" means run the
   workflow again (its number goes up each run); a complaint about the signing key means the
   bundle was signed with a different key than the first upload; a complaint about the
   package name means `appId` is not the name the app was created with.

---

## Part E: the purchase

### 13. Create the Remove Ads product

Two things come first. The payments profile (step 4). And the billing permission: Google's
page says only that the app must declare it, which this app does (the permission comes with
the billing library). Whether Play Console also wants a build with that permission uploaded
before it lets you create a product needs checking; after step 12 one is there in any case.

1. Play Console > your app > Monetize with Play > Products > **In-app products**. (Google
   now calls these "one-time products", and the menu may say so; its help page still gives
   the old name.) Click Create product.
2. **Product ID**: exactly the value of `iap.removeAdsProductId` in `app.config.json`, which
   is `remove_ads` today. Google's rules: it starts with a number or a lower-case letter and
   may contain numbers, lower-case letters, underscores and dots. **It can never be changed or
   used again**, not even after deleting the product, so type it carefully. It must be the
   same text as in App Store Connect, because the game has one setting for both stores.
3. Name (up to 55 characters; Google recommends 25) and description (up to 200):
   `store/listing.md` has both. Set the price.
4. Save, then **Activate**. A product that is not active cannot be bought and shows no price.
5. The product is bought once and kept for ever (it is never "consumed"), so it can be
   restored on a new phone. Nothing has to be set for that: it follows from how the game
   treats it.

### 14. Set up licence testers

A licence tester is a Google account that can buy without being charged, using test payment
methods that Google Play shows in place of a real card.

1. Play Console > Manage account > Play apps settings > Monetization settings > **License
   testing**. Add an email list with the Google accounts that should be testers (the account
   on your phone first), and save.
2. On a phone signed in with such an account, the payment sheet offers "Test instrument,
   always approves", "Test instrument, always declines" and two slow test cards. Nothing is
   charged.
3. To buy Remove Ads a second time with the same account, the first purchase has to be
   undone in two places. In Play Console, "refund and revoke" it, which is Google's advice:
   find the order under Order management, refund it, and choose to remove the entitlement as
   well. Without that the product stays owned. And on the phone, clear the game's storage
   (Settings > Apps > First Come > Storage > Clear storage, or from a computer
   `adb shell pm clear` followed by the package name): the game remembers in its saved state
   that Remove Ads was bought and never takes it away again by itself, so until that state is
   gone the Remove Ads button stays hidden. Clearing the storage also resets the progress in
   the game on that phone.

Licence testers may also buy in a build that did not come from Google Play, such as the debug
APK of step 11, as long as its package name is the one in Play Console.

### 15. The first real run on a phone: a checklist

Use the internal-testing build of step 12 on a real phone. None of this has been tried on a
device yet. Try it once on a phone with gesture navigation and once with the three-button
bar if you can, and once with the phone set to its light theme. If you can get hold of one,
**include a phone with Android 14 or earlier**: Android 15 and later treat the edges of the
screen differently by themselves, and the older versions are where the app's own handling
does the work.

- **Launch.** The dark launch screen with the emblem gives way to the first screen without a
  white flash. The clock and battery symbols in the status bar are light and readable,
  during launch and afterwards. The phone turned on its side: the game stays upright.
- **Consent.** In the EEA, the UK and Switzerland, Google's consent message appears before the
  first advert, and the game's settings show a "Privacy choices" row that opens it again.
  Elsewhere neither appears. (AdMob's Privacy & messaging pages explain how to pretend to be
  in the EEA with a test device.)
- **The edges of the screen.** The game's background reaches the top and bottom edges of the
  screen, behind the status bar and the navigation bar. Nothing of the game (its title, its
  buttons) is hidden under either bar, and there is no empty band of another colour above or
  below the game.
- **Banner.** A demo banner appears at the bottom of the play screen. **It does not cover the
  game's buttons, and it is not hidden behind the navigation bar or the gesture line.** Going
  back to the Home screen of the game takes it away; opening a level brings it back.
- **Banner on Android 14 or earlier with the three-button bar.** This is the combination
  most likely to be wrong. The banner sits directly above the navigation bar, the game's
  lowest buttons sit directly above the banner, **and there is no empty strip between them**
  (a strip about as tall as the navigation bar would mean the window is not edge to edge).
  The layout does not jump when the banner loads.
- **Changing the navigation style.** With a level open and the banner showing, switch the
  phone between gesture navigation and the three-button bar (Settings > System > Gestures, or
  wherever the phone keeps it) and come back to the game: the banner and the game's buttons
  have moved with the bar, with no gap and no overlap.
- **Banner after a reload.** With a banner showing, leave the app in the background until
  Android has discarded it (or, with the debug APK, reload the page from Chrome on a computer:
  `chrome://inspect`). The banner of the old page must not be left lying over the new one.
- **Full-screen adverts.** One appears now and then between levels and the game carries on
  afterwards. A rewarded video gives its reward; closing it early gives nothing.
- **Leaving during an advert.** While a full-screen advert is showing, press Home and then
  tap the game's icon. Android closes the advert when the app is opened this way. The game
  must carry on by itself within a few seconds; a rewarded video interrupted like this gives
  no reward.
- **Back.** With a sheet or a dialog open, Back closes it. In a level, Back goes to the game's
  Home screen. On the Home screen, Back puts the app in the background, and opening it again
  shows the game where it was. Try the Back gesture from both edges as well as the button.
  While a full-screen advert is showing, Back belongs to the advert. Pressed during the
  launch screen, before the game has appeared, Back also puts the app in the background.
- **Remove Ads.** The price appears. Buying with "Test instrument, always approves" goes
  through, the banner and the adverts between levels disappear, and they stay gone after the
  app is closed and opened again. Buying with "always declines" changes nothing. With a slow
  test card the adverts go only once the payment has gone through.
- **Restore.** After a purchase, clear the game's storage (Settings > Apps > First Come >
  Storage > Clear storage) and open the game: within a few seconds the adverts are gone again
  without your doing anything, because the game asks Google Play each time it starts. Then
  tap "Restore purchases" in the game's settings: it answers "Purchase restored. Adverts are
  off." On a phone whose Google account has not bought Remove Ads it answers "No earlier
  purchase was found." Uninstalling and reinstalling proves less than it seems to: Android
  may bring the saved state back by itself (see "Android's backup brings saved games back").
- **Saved game.** Progress is still there after closing and reopening the app, and after the
  phone has been restarted.
- **Sharing and links.** Sharing a result opens Android's share sheet. The privacy and
  support links open in a browser sheet inside the app and Back returns to the game.
- **Vibration** is felt on taps (if the phone has not turned touch vibration off).
- **Offline.** With the phone in aeroplane mode the game still starts and plays.
- **A tablet or an unfolded phone**, if you have one: the game stays in portrait.

### Android's backup brings saved games back

Android backs up the app's saved state (the progress in the game, the settings, and the note
that Remove Ads was bought) to the player's Google account, if the player has backup switched
on in the phone's settings, and puts it back when the app is installed again: from Google
Play, while setting up a new phone, or with `adb install`. Android's documentation, read on
14 November 2026: "Data is restored whenever the app is installed". A backup is made about
once a night, on Wi-Fi, while the phone is idle. This is Android's standard behaviour for an
app that does not switch it off (`android:allowBackup="true"` in the manifest, which is what
Capacitor's project has), and it is what lets a player keep their progress on a new phone.

For testing it means that "uninstall and install again" is not a clean start if a backup
has been made in between. For a clean start, clear the app's storage instead (Settings > Apps
> First Come > Storage > Clear storage). And it means that the note "Remove Ads was bought"
travels with the backup: the game does not check it against Google Play again, and never
takes Remove Ads away once it is set. For a purchase that was really made this is harmless,
since Google Play would say the same. After a refund the adverts stay off on that phone. If
that ever matters, the entitlement has to be kept out of the backup or checked against Play,
which needs a change to the game.

---

## Part F: the Play listing and the declarations

### 16. Fill in the store listing

Play Console > your app > Grow users > Store presence > Main store listing. The texts are in
`store/listing.md` (Part 2).

- **App name** (30 characters), **short description** (80), **full description** (4000).
- **App icon**: `resources/play/icon-512.png`. Google asks for 512 x 512 pixels, a 32-bit PNG
  (with alpha), at most 1024 KB. The file here is a PNG without an alpha channel; whether Play
  Console insists on one has not been tried. If it refuses the file, the art script needs a
  one-line change to export with alpha.
- **Feature graphic**: `resources/play/feature-graphic-1024x500.png`. 1024 x 500 pixels, JPEG
  or 24-bit PNG without alpha, which is what the file is.
- **Phone screenshots**: `store/screenshots-android/` (five, 1080 x 1920). Google wants at
  least 2 and at most 8, JPEG or 24-bit PNG without alpha, each side between 320 and 3840
  pixels, and the long side at most twice the short side. That last rule is why the iPhone
  screenshots cannot be reused. For a game to be eligible for the Store's screenshot-based
  recommendations, Google asks for at least three portrait screenshots of 1080 x 1920 or
  more: the five here qualify.
- **Category**: Game, Puzzle.
- **Contact details** (Store settings): the email address (required, public), and the website
  that carries app-ads.txt (step 9).
- **Privacy policy**: the game's `privacy.html` on the web. Required.

### 17. Answer the declarations ("App content")

Play Console > **App content**. Google's help page gave the way there, on 14 November 2026,
as "Policy > App content"; where the page sits in the menu needs checking (Play Console has
moved it more than once), so if you do not see it, type "App content" into the search box.
Google will not review the app until these are complete. The game itself collects nothing;
the answers follow from the advert software, as on iPhone.

1. **Privacy policy**: the same URL as in the listing.
2. **Ads**: **Yes**, the app contains ads. Google Play then shows "Contains ads" on the
   listing.
3. **Sign-in details** (older pages call it "App access"): everything in the app is available
   without signing in.
4. **Target audience and content**: tick **Ages 13-15, 16-17 and 18 and over**. Do **not**
   tick any group under 13: Google's Families policy would then apply, which restricts
   advertising to software certified for children and needs settings this app does not make.
   (Ticking only "18 and over" would let you switch on a feature called Restrict Minor
   Access, with which people Google determines to be under 18 cannot find, download or buy
   the app. It is an option, not something that happens by itself, and there is no reason
   for it here.) If Google judges that the listing appeals to children it may ask you to
   change the listing or the age groups.
5. **Content ratings**: fill in the questionnaire (category: game). It asks about violence,
   fear, sexual content, gambling, bad language, drugs: none. The ratings are worked out by
   the rating authorities of each region (IARC); for a puzzle with no such content the lowest
   rating everywhere is the expected result, but that has not been tried. If the
   questionnaire asks whether the app has in-app purchases: yes. An app without a rating is
   removed from Google Play, and a change to the game that changes an answer needs the
   questionnaire again.
6. **Data safety**: see below.
7. **Advertising ID**: **Yes**, the app uses the advertising id (the advert software does),
   for advertising and analytics. The permission it needs is already in the app. The exact
   wording of this declaration needs checking in Play Console.
8. Play Console lists further declarations from time to time (news apps, health, financial
   features, government apps). The game is none of these.

**The Data safety form.** Google's definitions: "collect" means sending data off the phone,
whoever receives it, and that includes what software from others inside the app sends;
"share" means passing it to a third party. Google publishes what its Mobile Ads SDK does at
<https://developers.google.com/admob/android/privacy/play-data-disclosure>. Read that page
while answering, because Google updates it. As read for this guide (it described version
25.5.0; the app is built with 25.4.0), the SDK collects four kinds of data automatically and
shares them "for advertising, analytics, and fraud prevention purposes", encrypted in transit:

| What Google's page says the SDK collects | The form's data type (under its heading) |
|---|---|
| The IP address, "which may be used to estimate the general location of a device" | Approximate location (Location) |
| "User product interactions": app launches, taps, video views | App interactions (App activity) |
| "Diagnostic information": launch time, hang rate, energy usage | Diagnostics (App info and performance) |
| "Device and account identifiers": the advertising id, the app set id | Device or other IDs (Device or other IDs) |

That leads to these answers:

1. Does the app collect or share any of the required user data types? **Yes.**
2. Is all of the user data encrypted in transit? **Yes.**
3. Do you provide a way for users to request that their data is deleted? The game keeps no
   data about anyone and has no accounts, so there is nothing of yours to delete; what the
   advert software holds is Google's, and people manage it in their phone's settings (Privacy
   > Ads). **No** is the plain answer; needs checking against the form's own help text.
4. For each of the four data types: **collected** and **shared**; not processed "ephemerally";
   collection is required (the person cannot switch it off inside the game); purposes
   **Advertising or marketing**, **Analytics** and **Fraud prevention, security, and
   compliance**.

Which of the form's data types matches which line of Google's page is this guide's reading,
not Google's statement: compare the form's own descriptions. Do not tick purchase history or
financial information: Google Play takes the payment, and neither the game nor the advert
software receives it.

---

## Part G: release

### 18. Closed testing, then apply for production (personal accounts)

Organisation accounts can skip to step 19.

1. Play Console > Test and release > Testing > **Closed testing** > the track Play Console
   offers > Create new release. Use the build from internal testing or upload a newer one.
   Add the testers (an email list, or a Google Group, which is easier for 12 or more people)
   and send them the link from the Testers tab.
2. Expect a closed-testing release to be reviewed by Google before testers can install it,
   and Play Console to insist that the listing and the declarations (steps 16 and 17) are
   complete first. Both need checking; neither is true of internal testing.
3. Watch the count on the Dashboard: 12 testers opted in, for 14 days running.
4. Then click **Apply for production** on the Dashboard and answer the questions: how you
   found testers, what they did and said, what you changed, why the app is ready. Google says
   the review of the application usually takes seven days or less.

### 19. Switch to real adverts and build the release

1. In `app.config.json` set `"testing": false`. Check the four ids under `admob.android` once
   more (and those under `admob.ios`, if the iPhone app is released from the same commit).
2. Raise `version` if a build with this version has already been released.
3. Run `npm run sync`. It prints a note if demo ids are still in place. Commit.
4. Run the release workflow again and download the bundle. This is the build you will release.
   The workflow refuses to build if `testing` is `false` while any of the four Android ids is
   still one of Google's sample ids: such a bundle would show demo adverts only and earn
   nothing.
5. On your own phone, do not tap the adverts in this build. Register the phone as a test
   device in AdMob (Settings > Test devices), which makes AdMob serve test adverts to it.

### 20. Release to production

1. Play Console > Test and release > **Production** > Create new release. Upload the bundle
   of step 19 (or promote it from a testing track), write release notes, and choose the
   countries the app is offered in (on the Production page; the exact tab needs checking).
2. Send the release for review. Google's statement: for some developer accounts reviews take
   "up to 7 days or longer in exceptional cases". A first app from a new account should
   expect the slow end. With **managed publishing** switched on, an approved release waits
   for you to press the button; otherwise it goes live when approved.
3. If the release is rejected, Play Console's Policy status page and an email say why.

### 21. After release

- In AdMob, link the Android app to its Google Play listing (in the app's settings in AdMob;
  the exact menu needs checking). AdMob then reviews the app, and adverts may be limited
  until that is done.
- Check the app-ads.txt tab in AdMob a day later (step 9).
- For an update: raise `version` in `app.config.json`, `npm run sync`, commit, run the release
  workflow, and create a new production release with the new bundle. Each upload needs a
  higher version code than the last; the workflow sees to that.

---

## The two CI workflows

Their templates are in `ci/`. To install one, copy it to `.github/workflows/` at the top of
the repository and fill in the placeholders, as the comment at the top of each file explains
(`__APP_DIR__` is the folder this guide is in; `__WEB_DIR__` is the folder of the web game).
Both run on GitHub's Linux machines (`ubuntu-latest`), which come with the Android SDK; the
workflows add Java 21. As read on 14 November 2026, that runner had Android platforms 34 to 37
and Java 21 installed.

### android-build.yml: does it still build, and a debug APK to try

Runs on every push that touches this folder or the web game, or by hand. It runs the tests
and `npm run sync`, builds the debug APK and the unsigned release bundle, and then opens both
and checks them: package name, version, name, the advertising-id and billing permissions, the
AdMob app id, portrait, and that the web game and the freshly built bridge are inside. It
needs no secrets. The debug APK is kept with the run for 14 days (step 11). A red run means
the last change broke the app.

**It has not yet run on GitHub.** Its build command and its checking step were run by hand on
a Linux machine and passed.

The iPhone build workflow watches this whole folder too, so a change that only concerns
Android also starts a build on one of GitHub's Mac machines, which cost more minutes than the
Linux ones. If that matters, exclude `android/` and this guide in the `paths` filter of the
iPhone build workflow.

### android-release.yml: the signed bundle for Google Play

Runs only by hand: repository > Actions > "Android release" > Run workflow. **It has never
been run.** It needs four repository secrets (Settings > Secrets and variables > Actions):

| Secret | What to put in |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | The keystore file of step 6, base64-encoded (see below) |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore's password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | The same password again |

To encode the file, and copy the output into the secret:

- macOS: `base64 -i upload-keystore.jks | pbcopy`
- Linux: `base64 -w0 upload-keystore.jks`
- Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("upload-keystore.jks"))`

What the workflow does: it first looks at `app.config.json` and stops if the package name
is still a placeholder (`com.example.`...) or if `admob.testing` is `false` while an Android
advert id is still one of Google's sample ids; with `admob.testing` set to `true` it goes on
and says in a warning that the bundle shows demo adverts only. Then: tests, `npm run sync`,
writes the keystore to a temporary file, builds the release bundle signed with it, and checks
the result: that it is signed, by the key in the keystore, with the expected package name and
version. The run's summary shows the key's SHA-256 fingerprint; it should be the one Play
Console shows under "Upload key certificate" on its Play app signing page (as Google's help
page gave the path on 14 November 2026: Protected with Play > Play Store protection > Manage
Play app signing). The signed `.aab` is kept with the run for 30 days. You upload it to Play
Console yourself; the workflow sends nothing to Google.

The version code is the workflow's run counter, so each run produces a higher number than the
last. If you have also uploaded a bundle built on your own computer with a higher number, type
a number into the "version_code" box when starting the run.

If the first run fails, the likely causes, in rough order:

- **A secret is missing or was pasted with something extra.** The first steps name the
  missing secret, or say that the keystore cannot be opened with the password, or that it
  has no key of that name.
- **A newer release of an action behaves differently.** The workflows use
  `actions/setup-java@v6` and `actions/upload-artifact@v7` (with its option to upload one
  file without zipping it), which could not be tried here.
- **The Android SDK on the runner lacks a part.** The Android build tool downloads what it
  misses, which needs the licences to be accepted on the runner; GitHub's runners have them.

## Building on your own computer

The alternative to the workflows. You need Java 21, the Android SDK (Android Studio installs
it and tells you where; the build finds it through the `ANDROID_HOME` variable or the file
`android/local.properties`, which Android Studio writes) and Node.js 22.18 or later.

1. In this folder: `npm ci`, then `npm run sync`. Always run `npm run sync` before building:
   the copy of the web game and a few generated files are not committed and appear only then.
2. A debug APK: `cd android`, then `./gradlew assembleDebug` (on Windows `gradlew.bat
   assembleDebug`). The file is `android/app/build/outputs/apk/debug/app-debug.apk`. With a
   phone attached by cable, `./gradlew installDebug` builds and installs it.
3. In Android Studio instead: `npx cap open android`, wait for it to finish reading the
   project, choose a phone or an emulator at the top and press Run.
4. A signed release bundle: set the four values of step 6, for example for one terminal
   session

   ```
   export ANDROID_KEYSTORE_FILE=/full/path/to/upload-keystore.jks
   export ANDROID_KEYSTORE_PASSWORD='the password'
   export ANDROID_KEY_ALIAS=upload
   export ANDROID_KEY_PASSWORD='the password'
   ```

   or once and for all as four lines `NAME=value` in the file `gradle.properties` inside the
   `.gradle` folder of your home folder (not the one in `android/`, which is committed). Then
   raise `build` in `app.config.json`, `npm run sync`, and `./gradlew bundleRelease`. The
   file is `android/app/build/outputs/bundle/release/app-release.aab`. Check it with
   `jarsigner -verify` followed by the file's path, which must answer "jar verified".

If you edit `AndroidManifest.xml`, `build.gradle`, `strings.xml` or `styles.xml` by hand, the
script keeps what you added and puts back only the values it owns. `MainActivity.java` it
writes whole, until you delete the comment at its top (see "The one rule"). If it meets a file
it does not understand (a manifest that is not well formed, a build file without the lines
Capacitor writes, a `MainActivity.java` of your own that no longer makes the window edge to
edge), `npm run sync` stops and says so rather than guess, and it does so before it has
changed anything, in either project.

## Keeping things current

- **The target Android version.** Google Play raises the minimum every year. Since 31 August
  2026 new apps and updates must target Android 16 (API level 36), which this project does.
  The level comes from Capacitor (`android/variables.gradle`). Next summer: update the
  Capacitor packages, `npm run sync`, build. `npm run sync` prints a note when the project's
  level is below the one written into `scripts/configure-android.mjs`; that number needs
  raising by hand once a year, from Google's page "Target API level requirements for Google
  Play apps".
- **16 KB memory pages.** Google Play requires apps that target Android 15 or later to work on
  phones with 16 KB memory pages, and from 1 February 2027 refuses updates that do not. This
  concerns machine code inside an app. This app has none (the built APK and bundle contain no
  `.so` file), and Android's documentation says that such an app "already supports 16 KB
  devices". The build workflow counts the `.so` files in every build and warns if a plugin
  ever brings one; then check that plugin's notes for 16 KB support, and see
  <https://developer.android.com/guide/practices/page-sizes>.
- **The billing library.** Google retires old versions of the Play Billing Library on a fixed
  timetable. The purchases plugin uses version 9, which new apps and updates may use until
  31 August 2028. After that the plugin needs updating.
- **Google's advert library.** The AdMob plugin asks for version 25.4.x of the Google Mobile
  Ads SDK, so builds pick up the newest 25.4 release of the day (25.4.0 on 14 November
  2026). The build workflow's summary shows the version of each build.
- **Capacitor 9.** Capacitor's documentation says that from version 9 Capacitor makes the
  window edge to edge itself (read on 14 November 2026). `MainActivity.java` does it today.
  After that update a test in `test/configure-android.test.js` fails on purpose and says so;
  the call in `MainActivity.java` is then harmless, and the script and the test can be
  simplified. Any plugin update can also turn `test/plugin-sources.test.js` red: those tests
  read the plugins' own code for the handful of behaviours the bridge depends on, and a
  failure means "read what changed there before shipping".
- **Adding a Capacitor plugin.** After `npm install`, run `npm run sync` and build. Then look
  at what the plugin added to the app: the summary of the build workflow lists the app's
  permissions, so compare it with the run before. A new permission may need a new answer in
  the Data safety form or a declaration of its own in Play Console.

## Commands

| Command | What it does |
|---|---|
| `npm run sync` | A check of `app.config.json` for both platforms, the bridge build, `cap sync` for iPhone and Android, then both configure scripts. The command to run after any change. |
| `npm run check:config` | Only that first check: changes nothing; says what iPhone or Android would refuse. |
| `npm run configure:android` | Only the Android part of the last step: apply `app.config.json` and `resources/android` to `android/`. |
| `npm run configure:android -- --check` | Changes nothing; fails if `android/` is out of step with `app.config.json`. |
| `npm run art` | Redraw the icons, the launch art and the Play listing graphics. |
| `npm test` | All tests, including the ones for the configure scripts. Needs no Android SDK. |
| `./gradlew assembleDebug` (in `android/`) | Build the debug APK. |
| `./gradlew bundleRelease` (in `android/`) | Build the release bundle: signed if the four signing values are set, unsigned otherwise. |

## What has not been verified

Checked on Linux, on 14 November 2026:

- `npm run sync` runs from start to finish for both platforms and a second run changes
  nothing; the tests of the configure script pass from a fresh copy of Capacitor's template.
- `./gradlew assembleDebug bundleRelease` succeeds (Java 21, Android SDK platform 36). In
  the built APK and bundle, Android's and Java's own tools (`aapt2`, `dexdump`, `jarsigner`,
  `keytool`) show: the package name, version and name from `app.config.json`;
  target API 36 and minimum API 24; the advertising-id and billing permissions; the AdMob app
  id; portrait; no unencrypted traffic; the adaptive icon; the web game with the bridge that
  was just built; no machine code.
- In the built APK, `MainActivity` calls `EdgeToEdge.enable` with two dark bar styles straight
  after `super.onCreate` (read from the compiled code with `dexdump`). That is all that is
  known about it: see below.
- A release bundle signed with a throw-away key through the four environment variables, with
  the version code given from outside, verifies with `jarsigner` against that key. A partly
  configured signing stops the build with a message that names what is missing.
- Android's lint tool reports no errors for the app (18 warnings, among them that the icon
  has no single-colour version for Android 13's themed icons).
- The steps of both workflows that are plain shell were run by hand with stand-ins for
  GitHub's environment, including their failure cases: among them the release workflow's
  refusal of sample advert ids when `admob.testing` is `false`.
- In a copy of the project with an iPhone bundle id that has hyphens in it: `npm run sync`
  stopped before writing anything and proposed the `androidAppId` line; with that line added
  it configured both projects, and the Android app built under its own package name.
- The part of the bridge that watches the bottom inset was run in a real browser (headless
  Chrome 153) on a page with the game's own stylesheet: a change of the inset alone is
  noticed. `npm test` repeats this wherever Chrome is installed and skips it elsewhere.

Not checked, because it needs a phone, a Google Play account, an AdMob account or GitHub:

- **The app has never run**, on a phone or an emulator. Everything in the checklist of step
  15 is untried: the launch screen and the hand-over to the game, the colour of the system
  bars, where the banner sits relative to the navigation bar, the consent message, adverts,
  the purchase and restore, the Back button, sharing, vibration.
- **Edge to edge on Android 14 and earlier.** That the window has to be made edge to edge
  there, and that the banner would otherwise sit under an empty strip, was worked out from
  Android's and Capacitor's documentation and from the source of Capacitor and the AdMob
  plugin. Nobody has seen either the fault or the cure on a phone. The two "Banner" items and
  "The edges of the screen" in step 15 are the test.
- That Google Play never leaves a price or ownership lookup unanswered now that the bridge
  sends them one at a time. The fault was found by reading the purchases plugin's source and
  is reproduced in the tests with a stand-in for the plugin, not with Google Play.
- That the launch screen looks right. The emblem is the launcher icon's foreground layer,
  which Android enlarges for the launch screen; whether it looks sharp enough on a
  high-resolution screen has not been seen.
- The two workflows on GitHub: the Java and artifact actions at their current versions, the
  cache, and the upload of a single file without a zip.
- That Play Console accepts the bundle, the upload key, the icon file without an alpha
  channel and the screenshots, and what the content rating questionnaire answers.
- The whole route of steps 12 to 20 in Play Console: Play App Signing, the one-time product,
  licence testers, the closed test and the application for production.
- The Data safety answers against the form itself, and the Advertising ID declaration.
- How Android's backup behaves with this app: that a reinstall brings the saved game back,
  and how soon.
- Tablets, unfolded phones and Chromebooks. The game is marked as a game so that Android 16
  keeps it in portrait there; nobody has seen it.
