# Kingston Tutoring for iPhone

A free companion app for students who have already booked a class on the website. It shows each class in UK
time (and the student's own time when their phone is set to another time zone), the join link for each
session, date changes and cancellations, optional reminders and **Add to Calendar**. Students can request a
cancellation and remove a booking from the phone. It works offline with the last saved details.

**The app sells nothing.** It has no prices, booking buttons or links to buy, and the support, privacy and
terms pages open in an "app view" with no links to the calendar or booking pages. Booking and payment stay
on the website (Stripe). This keeps it inside App Store Guideline 3.1.3(f), "free stand-alone apps": apps
that sell live group classes inside the app must use Apple's in-app purchase (3.1.3(d)), and apps must not
steer people to buy elsewhere (3.1.1). See [AppStore/submission-checklist.md](AppStore/submission-checklist.md#if-app-review-objects)
for the review risks and what to do if App Review objects.

## What you need

- A Mac with **Xcode 26 or later** (free from the Mac App Store). Apple only accepts uploads built with a
  recent Xcode.
- An **Apple Developer Program** membership (US$99 a year, charged in local currency) to run the app on an
  iPhone and to publish it. The Simulator works without one.
- Your booking site **deployed** ([docs/DEPLOY.md](../docs/DEPLOY.md)). The app talks to it.

## Run it (about 10 minutes)

1. Get the code: download the zip you were sent and unzip it, or `git clone` the repository.
2. Edit **`ios/Config.xcconfig`**. It's the only file you change:
   - `KT_PUBLIC_HOST`: your site's host name, without `https://`, e.g. `kingston-tutoring.yourname.workers.dev`
   - `DEVELOPMENT_TEAM`: your 10-character Team ID (developer.apple.com → Account → Membership details)
   - `KT_BUNDLE_ID`: an identifier you own, e.g. `uk.yourname.tutoring`. It can't change after the first upload.
3. Let the site open the app for private links. In `workers/public/wrangler.jsonc` set
   `"APPLE_APP_IDS": "<TEAM ID>.<bundle id>"` (e.g. `"ABCDE12345.uk.yourname.tutoring"`), then
   `npm run deploy:public`.
4. In Terminal:
   ```bash
   cd ios
   ./setup.sh
   ```
   This checks your settings and the live site, runs the app's tests, compiles the app and opens Xcode.
5. In Xcode, pick an iPhone simulator at the top and press **⌘R**.
   - **No live site yet?** *Product → Scheme → Edit Scheme… → Run → Arguments*, tick **`-KTDemo`** and press
     ⌘R. The app runs with fictional demo bookings and needs no server. This only works in Debug builds; the
     App Store build never contains it.
6. On your own iPhone: connect it, choose it at the top of Xcode, press ⌘R. The first time, turn on
   *Settings → Privacy & Security → Developer Mode* on the phone when asked.

### Try it with a real booking

In the dashboard open any confirmed booking → **Prepare confirmation email (new private link)** → copy the
link. On the iPhone, open it from Notes or Mail and the app opens with the booking. You can also copy the
link, tap **+** in the app and paste it.

## Tests

```bash
cd ios
./setup.sh test      # 47 logic tests (works on any Mac, and on Linux with Swift installed)
./setup.sh build     # compiles the SwiftUI app for the Simulator
```

The logic tests cover link parsing, the API client and its errors, offline use, keys and the cache,
changes made while a refresh is in flight, reminders (including summer time and the 64-notification
limit), time-zone display and the demo server. In Xcode, **⌘U** runs the same tests on the Simulator.

**Live check against your deployed site** (adds a booking, refreshes it, then removes it from the test's
memory; the emailed link keeps working):

```bash
KT_CONTRACT_LINK="https://your-site/b/…" ./setup.sh test
```

Add `KT_CONTRACT_REQUEST_CANCELLATION=1` to also send a cancellation request. Only do that with the App
Review demo booking, because the request shows up on your dashboard.

The server side of the app (JSON API, universal-links file, app view of the policy pages) is covered by
`npm test` (`test/acceptance/app-api.test.ts`).

## Publish to the App Store

Follow **[AppStore/submission-checklist.md](AppStore/submission-checklist.md)**. It points to the
ready-to-paste listing text ([metadata.md](AppStore/metadata.md)), App Review notes
([review-notes.md](AppStore/review-notes.md)) and privacy answers ([privacy-labels.md](AppStore/privacy-labels.md)).
`./setup.sh screenshots` makes the App Store screenshots.

## How it works

- **Adding a booking**: the app sends the private link to `/api/app/v1/link`. The server checks it and issues
  a separate key for this iPhone (stored only as a hash on the server, and in the iPhone Keychain, "this
  device only"). The emailed link is not used up and keeps working.
- **Refreshing**: on launch, on return to the app and on pull-to-refresh, the app sends its keys to
  `/api/app/v1/bookings` and gets the latest dates, links and status. If the server can't be reached, the
  saved copy stays and a banner says so. Only an explicit "revoked" answer removes a booking.
- **Removing** a booking (or *Remove all*) deletes it from the phone and switches its key off on the server.
  **Revoke all private links** on the dashboard also signs every app out of that booking.
- **Reminders** are local notifications planned on the phone (confirmed classes only, rebuilt on every
  refresh, so moved dates update). Nothing is sent to a server for them.
- **No accounts, no tracking, no analytics or advertising SDKs, no third-party code.**

## Files

```
ios/
  KingstonTutoring.xcodeproj  open this in Xcode
  Config.xcconfig             the only file you edit
  setup.sh                    check · test · build · screenshots
  App/                        SwiftUI screens, Keychain, notifications, Calendar sheet, icon, privacy manifest
  KingstonTutoringCore/       all the app's logic, with its tests (swift test)
  Support/                    Info.plist and entitlements (filled in from Config.xcconfig)
  AppStore/                   listing text, review notes, privacy answers, checklist
  project.yml                 fallback to regenerate the Xcode project (XcodeGen)
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "Signing for KingstonTutoring requires a development team" | Set `DEVELOPMENT_TEAM` in `Config.xcconfig`, or pick your team under *Signing & Capabilities*. |
| Private links open Safari, not the app | Run `./setup.sh check`: the universal-links file must list `<TEAM ID>.<bundle id>`. Apple can take up to a day to pick up a change. Links must be tapped (in Mail, Notes or Messages), not typed into Safari's address bar. Long-press a link and choose *Open in "Kingston Tutoring"* to test. |
| "You seem to be offline" with a connection | Check `KT_PUBLIC_HOST`, and that `https://<host>/api/app/v1/config` opens in Safari. |
| Xcode won't open the project | `brew install xcodegen && ./setup.sh regenerate` rebuilds it from `project.yml`. |
| A build error in `App/` | The SwiftUI screens were written and reviewed without a Mac, so your first `./setup.sh build` is their first compile (the logic in `KingstonTutoringCore` is compiled and tested). Copy the first error from Xcode's Issue navigator (⌘5) into a Claude Code session on this repository to have it fixed. |
