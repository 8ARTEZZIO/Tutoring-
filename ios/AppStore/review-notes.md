# App Review notes and demo booking

The reviewer needs a working booking to see anything, so each submission needs a **demo link**. It must
stay valid (dates in the future, site up) until the review is finished.

## Make the demo booking (5 minutes, once)

On your **production** dashboard:

1. **New listing**: title `App Review demo`. Leave it as a **draft**. Drafts never appear on the public site,
   and the app still shows bookings on them.
2. Add two or three dates starting next week and running for about six weeks, each with a real `https://`
   call link (an empty test room is fine). The app only shows `https` join links.
3. On the listing, under **Register a separately paid student**: first name `App Review`, an email address
   you control (e.g. `you+appreview@…`), payment reference `App Review demo`, amount received `0`. Press
   **Register and issue private link** and copy the link it shows (`https://<host>/b/…`).
4. Check the link: paste it into the app on your iPhone (**+**). You should see a confirmed booking with
   join links.

Nothing is charged and no Stripe payment is involved. Keep this listing for future updates: before each
submission, add new future dates if needed and issue a fresh link from the booking (**Prepare confirmation
email (new private link)**). The demo student's cancellation requests and the email address you used are
yours, so nothing reaches a real student.

This flow is rehearsed by the automated tests (`test/acceptance/app-api.test.ts`, "App Review demo
student") and was run against a local copy of the site with the real iPhone networking code.

## Notes to paste into App Store Connect

Replace `<DEMO LINK>` with the link from step 3.

```
Kingston Tutoring is a free companion app for students who have booked a live small-group class on our website. Bookings are made and paid for on the website. The app sells nothing: it has no prices, no purchase buttons and no links to buying (Guideline 3.1.3(f), free stand-alone companion to a paid web service). The help, privacy and terms pages open in an app view without the website's navigation.

There is no account or sign-in. A student adds a booking with the private link from their confirmation email.

To review:
1. Copy this demo booking link: <DEMO LINK>
2. Open the app and tap + (Add booking). Tap Paste, or paste the link into the field and tap Add booking. (Opening the link from Mail or Notes on the device opens the app directly as well.)
3. The demo booking opens: class dates in UK time (if the device isn't set to UK time, your own time is shown too), a Join class button for each session, Add to Calendar, Request cancellation and Remove from this iPhone.
4. Settings (gear icon): class reminders (local notifications, after the system permission prompt), support, privacy notice, booking terms, remove all bookings, and a data deletion request by email.

The demo booking is on a hidden test class created for App Review. Join class opens an empty test video room. Request cancellation only sends a request to the tutor; no payment or refund happens in the app. The app works offline with the last saved details.

Kingston Tutoring is independent peer tutoring and is not affiliated with Kingston University.
```

## If the reviewer can't load the booking

- Check the site is up: `https://<host>/api/app/v1/config` should show some JSON.
- Check the link in the app yourself. If it says the link isn't valid, it was replaced or revoked; issue a
  fresh one (step 3 or **Prepare confirmation email (new private link)**) and reply in the Resolution
  Center with it.
- If all the dates have passed, the booking shows under "Past and cancelled" with no join links. Add new
  future dates.
