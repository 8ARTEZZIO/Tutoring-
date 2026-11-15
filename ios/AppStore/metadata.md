# App Store listing text

Ready to paste into App Store Connect. Character limits are checked. Replace `<host>` with your
`KT_PUBLIC_HOST` and `<seller name>` with the seller name shown on your site.

Two rules shaped the wording. Don't add prices, "book now" or links to the booking pages anywhere here:
App Store metadata may not point people to buying outside the app (Guideline 3.1.1). And keep the
not-affiliated sentence: the name mentions Kingston.

| Field | Text |
|---|---|
| Name (30) | `Kingston Tutoring` |
| Subtitle (30) | `Your class times and links` |
| Primary category | Education |
| Secondary category (optional) | Productivity |
| Support URL | `https://<host>/support?view=app` |
| Marketing URL | leave empty |
| Privacy policy URL | `https://<host>/privacy?view=app` |
| Copyright | `2026 <seller name>` |
| Age rating | 4+ (answer *None* / *No* throughout the questionnaire) |
| Price | Free |

The `?view=app` addresses show the same support and privacy pages without the site's navigation, so the
listing never leads to the booking pages.

## Promotional text (170)

```
Your live class dates, join links and reminders in one place. Add a booking with the private link from your confirmation email.
```

## Keywords (100, comma-separated, no spaces)

```
tutoring,python,class,lesson,reminder,calendar,student,study,coding,revision,timetable,schedule,join
```

## Description

```
Kingston Tutoring keeps your live small-group classes in one place.

Add your class with the private link from your booking confirmation, and the app shows:

• every date and time in UK time, plus your own time when your iPhone is set to another time zone
• the join link for each session
• changes straight away if a date moves or a session is cancelled
• reminders before each class, at the time you choose
• one tap to add a session to your calendar
• a simple way to ask for a cancellation, with the cancellation terms beside it

Your class details stay available offline. There's no account to create and no tracking. Each booking is kept on your iPhone with its own private key, and you can remove it at any time.

Kingston Tutoring is independent peer tutoring. It is not run by, affiliated with or endorsed by Kingston University.
```

## What's New

Not needed for version 1.0. For later versions, describe the change in a line or two.

## Screenshots

`cd ios && ./setup.sh screenshots` saves three 1320 × 2868 PNGs to `ios/AppStore/screenshots/`: the class
list, a four-session booking with its join links, and Settings. Upload them to the **6.9-inch iPhone**
slot. They're taken from the real app running on fictional demo data, with a clean status bar. If you'd
rather show your real classes, take screenshots on an iPhone 16 Pro Max or 17 Pro Max (side button + volume
up) after adding a booking.
