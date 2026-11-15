# App Store submission checklist

Work through this top to bottom. Everything the app itself needs for review is already in the project: app
icon, privacy manifest (`App/Resources/PrivacyInfo.xcprivacy`), in-app privacy and support links, the
encryption declaration (`ITSAppUsesNonExemptEncryption = NO`, so there's no export question on upload),
iPhone-only portrait layout, and no tracking or third-party SDKs.

## 1. Accounts and the live site

- [ ] Enrol in the **Apple Developer Program** (developer.apple.com/programs, US$99 a year in local
      currency). As an individual, your legal name is shown as the seller on the App Store. Approval can take
      a day or two.
- [ ] Optional but worth it: join the **App Store Small Business Program** (appstoreconnect.apple.com →
      Agreements). It doesn't affect this free app, but halves Apple's commission (to 15%) if you ever add
      in-app purchase.
- [ ] The site is **deployed and in production** ([docs/DEPLOY.md](../../docs/DEPLOY.md)), with seller
      details, terms and privacy wording filled in on the dashboard.
- [ ] If you changed the privacy wording on the dashboard before this update, add a paragraph about the
      iPhone app (the default text now has one under "The iPhone app"; copy it from a fresh install or
      `src/shared/settings.ts`).

## 2. Configure, test, build

- [ ] Fill in `ios/Config.xcconfig` (host, Team ID, bundle ID) and set `APPLE_APP_IDS` in
      `workers/public/wrangler.jsonc`, then `npm run deploy:public`.
- [ ] `cd ios && ./setup.sh`: every line shows ✓, the tests pass and the app builds.
- [ ] Run on your own iPhone from Xcode and go through [the device test](#device-test) below.

## 3. Create the App Store Connect record

appstoreconnect.apple.com → **Apps → + → New App**:

- [ ] Platform **iOS**; Name: see [metadata.md](metadata.md); Primary language **English (U.K.)**.
- [ ] Bundle ID: the one in `Config.xcconfig`. If it isn't in the list yet, register it at
      developer.apple.com → Identifiers (App ID, with **Associated Domains** ticked), or archive once from
      Xcode with automatic signing, which registers it for you.
- [ ] SKU: anything unique, e.g. `kingston-tutoring-ios`. User access: Full.

## 4. Upload a build

- [ ] Each upload needs a higher `CURRENT_PROJECT_VERSION` in `Config.xcconfig` (1, 2, 3…).
- [ ] Xcode: choose **Any iOS Device (arm64)** as the destination → **Product → Archive**.
- [ ] In the Organizer: **Distribute App → App Store Connect → Upload**, keeping the defaults (automatic
      signing).
- [ ] Wait for the "build has completed processing" email (usually 10–30 minutes).
- [ ] **TestFlight → Internal Testing**: add yourself, install from the TestFlight app on your iPhone and
      repeat [the device test](#device-test) on this exact build. This is the build Apple will review.

## 5. Fill in the listing

On the app's page in App Store Connect:

- [ ] **App Information**: subtitle, category (**Education**), content rights (**No**, it doesn't show
      third-party content), age rating questionnaire: answer *None* or *No* to everything (no in-app web
      browser, no chat, no user content shown to others, no ads). Expect **4+**.
- [ ] **Pricing and Availability**: price **Free**. Availability: **United Kingdom** only to start with. The
      classes are for Kingston students, and the EU "trader status" declaration (Digital Services Act) only
      applies to EU storefronts.
- [ ] **App Privacy**: privacy policy URL and the answers in [privacy-labels.md](privacy-labels.md).
- [ ] **Version 1.0 page**: promotional text, description, keywords, support URL from
      [metadata.md](metadata.md). Leave the marketing URL **empty**: your home page sells classes.
- [ ] **Screenshots** (6.9-inch iPhone): `cd ios && ./setup.sh screenshots`, then drag
      `ios/AppStore/screenshots/*.png` (1320 × 2868) into the 6.9" slot. They come from the real app running
      on fictional demo data. Smaller iPhones reuse them automatically.
- [ ] **Build**: select the TestFlight build you tested.
- [ ] **App Review Information**: your name, phone and email; *Sign-in required* **off**; paste the notes
      from [review-notes.md](review-notes.md), including a working demo link.
- [ ] **Version release**: *Manually release this version*, so you choose the day it goes live.

## 6. Submit

- [ ] **Add for Review → Submit**. Reviews usually take a day or two. Keep the site running and the demo
      booking valid (its dates in the future) until the app is approved.
- [ ] After approval: **Release**. Then, if you like, mention the app in your confirmation email template
      ("Get your class times and reminders on iPhone: search Kingston Tutoring on the App Store"). Keep it
      out of any payment step.

## Device test

Do this on a real iPhone (from Xcode, then again from TestFlight):

1. Open a private link from Mail or Notes → the app opens and shows the booking.
2. Join link opens the call; **Add to Calendar** pre-fills the event; the times match the website.
3. Settings → turn on reminders → allow notifications. A test booking starting in about 20 minutes with
   "15 minutes before" shows the reminder; tapping it opens the booking.
4. Change a date on the dashboard → pull to refresh → the new time shows and the reminder moves.
5. Airplane mode → open the app → saved details are shown with the "offline" banner.
6. **Request cancellation** → it appears on the dashboard. **Remove from this iPhone** → the booking goes,
   and the emailed link still works in Safari.
7. Dashboard → **Revoke all private links** on that booking → refresh in the app → it is removed with a
   message.
8. Turn on *Larger Text* (Settings → Accessibility) and VoiceOver briefly: text grows and buttons are read
   out.

## If App Review objects

The usual objections for an app like this, and how to answer them in the Resolution Center:

- **3.1.1 / 3.1.3 (payments).** Point out that the app is a free stand-alone companion to a paid web
  service (Guideline **3.1.3(f)**), with no purchasing and no calls to action to buy: no prices, no booking
  buttons, and the help pages open without site navigation. If Apple still insists, there are two ways
  forward: offer the classes through **in-app purchase** as well (3.1.3(d) requires it for group classes
  bought *in* the app; it's a substantial piece of work: StoreKit, server-side verification, seat holds), or
  stay **web-only**, since the site already works well on phones and can be added to the Home Screen.
- **4.2 (minimum functionality).** Explain the native features: local reminders that follow date changes,
  Add to Calendar, offline access, universal links from the confirmation email, cancellation requests. If
  needed, a home-screen widget showing the next class is the natural addition.
- **2.1 (couldn't review).** Usually an expired demo link or a site that was down. Issue a fresh link (see
  [review-notes.md](review-notes.md)) and reply with it.
- **5.2.1 (name or affiliation).** "Kingston" could be read as implying a link with Kingston University. The
  description, website and app all say it isn't affiliated. If Apple asks, change the App Store name (the
  home-screen name comes from `KT_DISPLAY_NAME` in `Config.xcconfig`) to something without "Kingston".
