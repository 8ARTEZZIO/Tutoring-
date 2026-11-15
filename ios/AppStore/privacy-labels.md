# App Privacy answers (App Store Connect → App Privacy)

These answers match what the app does and the privacy manifest in
`App/Resources/PrivacyInfo.xcprivacy`. You're responsible for the answers you submit, so read the reasoning
and change them if you change the app or the site.

## Short version

| Question | Answer |
|---|---|
| Do you or your third-party partners collect data from this app? | **Yes** |
| Data used to track you | **None** |
| Identifiers → **User ID** | Collected · **Linked to the user** · Not used for tracking · Purpose: **App Functionality** |
| User Content → **Customer Support** | Collected · **Linked to the user** · Not used for tracking · Purpose: **App Functionality** |
| Everything else (contact info, location, contacts, health, financial info, browsing, search, usage data, diagnostics, purchases, other identifiers) | **Not collected** |
| Privacy policy URL | `https://<host>/privacy?view=app` |

## Why

**What leaves the phone.** The app sends exactly three kinds of data to your site, and nowhere else:

1. The private booking link, once, when a student adds a booking. The server answers with a separate key
   for this iPhone and keeps only a hash of it, attached to the booking. The app sends that key back on
   every refresh. It is an identifier assigned to the student's booking, so it's declared as **User ID**,
   linked to the user, for app functionality.
2. The optional note in **Request cancellation**. It's stored with the booking and read by the tutor, so
   it's declared as **Customer Support**, linked to the user.
3. A request to switch a key off when a booking is removed (no new data).

**What isn't collected by the app.** The student's name, email and payment were given on the website,
which your privacy notice covers. The app never sends them; it only displays the first name and class
details the server returns, so name, email and purchase history are not "collected" by the app in
Apple's sense (collection means transmitting data off the device). There are no analytics, advertising,
crash-reporting or other third-party SDKs, and no access to contacts, photos, location or the calendar
database (Add to Calendar uses Apple's own add-event sheet, and the student saves the event).

**IP addresses.** Like every web request, app requests reach your site from an IP address. The site never
stores the address: rate limiting counts requests under a keyed hash of it, and those counters are deleted
after a day. Per-request logs are switched off, and the site's own logs contain no IP addresses, tokens or
emails (see docs/DEPLOY.md). That's processing to serve and protect the request, not collection linked to
a person, so it isn't declared.

**Required-reason API.** The app stores the reminder settings and the last refresh time in
`UserDefaults`, declared in the privacy manifest with reason `CA92.1` (the app's own data). No other
required-reason APIs are used.

**Deleting data.** There are no accounts to delete. In the app, *Remove from this iPhone* and *Remove all
bookings* delete everything stored on the phone and switch the keys off on the server, and *Ask for your
data to be deleted* emails you. Handle that request as described in
[docs/RUNBOOK.md](../../docs/RUNBOOK.md#data-requests).
