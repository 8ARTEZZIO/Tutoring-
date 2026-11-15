import XCTest
@testable import KingstonTutoringCore

final class ReminderPlannerTests: XCTestCase {
    let uk = TimeZone(identifier: "Europe/London")!
    let now = Fixture.now
    let on = ReminderPreferences(enabled: true, leadMinutes: [60])

    func testNothingIsPlannedWhenRemindersAreOff() {
        let booking = Fixture.booking("b", sessions: [Fixture.session("s", start: now.addingTimeInterval(86_400))])
        XCTAssertEqual(ReminderPlanner.plan(for: [booking], preferences: .default, now: now, deviceZone: uk), [])
    }

    func testOnlyConfirmedBookingsAndLiveFutureSessionsGetReminders() {
        let start = now.addingTimeInterval(86_400)
        let bookings = [
            Fixture.booking("ok", sessions: [Fixture.session("ok1", start: start), Fixture.session("ok2", start: start.addingTimeInterval(604_800), cancelled: true)]),
            Fixture.booking("pending", status: .pending, sessions: [Fixture.session("p1", start: start)]),
            Fixture.booking("review", status: .review, sessions: [Fixture.session("r1", start: start)]),
            Fixture.booking("cancelled", status: .cancelled, sessions: [Fixture.session("c1", start: start)]),
            Fixture.booking("group", sessions: [Fixture.session("g1", start: start)], groupCancelled: true),
            Fixture.booking("past", sessions: [Fixture.session("old", start: now.addingTimeInterval(-3_600))]),
        ]
        let plan = ReminderPlanner.plan(for: bookings, preferences: on, now: now, deviceZone: uk)
        XCTAssertEqual(plan.map(\.identifier), ["kt.reminder.ok1#0#60"])
        XCTAssertEqual(plan.first?.fireDate, start.addingTimeInterval(-3_600))
        XCTAssertEqual(plan.first?.bookingId, "ok")
    }

    func testSkipsLeadTimesThatHaveAlreadyPassed() {
        let start = now.addingTimeInterval(30 * 60)
        let booking = Fixture.booking("b", sessions: [Fixture.session("s", start: start)])
        let plan = ReminderPlanner.plan(for: [booking], preferences: ReminderPreferences(enabled: true, leadMinutes: [15, 60, 1440]), now: now, deviceZone: uk)
        XCTAssertEqual(plan.map(\.identifier), ["kt.reminder.s#0#15"])
    }

    func testRescheduledSessionsGetNewIdentifiers() {
        let a = Fixture.booking("b", sessions: [Fixture.session("s", start: now.addingTimeInterval(86_400), sequence: 0)])
        let b = Fixture.booking("b", sessions: [Fixture.session("s", start: now.addingTimeInterval(90_000), sequence: 1)])
        let first = ReminderPlanner.plan(for: [a], preferences: on, now: now, deviceZone: uk)
        let second = ReminderPlanner.plan(for: [b], preferences: on, now: now, deviceZone: uk)
        XCTAssertNotEqual(first.first?.identifier, second.first?.identifier)
        XCTAssertEqual(second.first?.fireDate, now.addingTimeInterval(90_000 - 3_600))
    }

    func testCapsAtTheSoonestSixtyAndDeduplicatesSharedSessions() {
        let sessions = (0..<80).map { i in Fixture.session("s\(i)", start: now.addingTimeInterval(TimeInterval(86_400 + i * 3_600)), number: i + 1, of: 80) }
        let booking = Fixture.booking("b", sessions: sessions.shuffled())
        let duplicate = Fixture.booking("b2", sessions: [sessions[0]])
        let plan = ReminderPlanner.plan(for: [booking, duplicate], preferences: on, now: now, deviceZone: uk)
        XCTAssertEqual(plan.count, ReminderPlanner.maximum)
        XCTAssertEqual(plan.first?.identifier, "kt.reminder.s0#0#60")
        XCTAssertEqual(Set(plan.map(\.identifier)).count, plan.count)
        XCTAssertEqual(plan.map(\.fireDate), plan.map(\.fireDate).sorted())
        XCTAssertTrue(plan[0].body.hasPrefix("Session 1 of 80."))
    }

    func testIgnoresNonsenseLeadTimes() {
        let booking = Fixture.booking("b", sessions: [Fixture.session("s", start: now.addingTimeInterval(20 * 86_400))])
        let plan = ReminderPlanner.plan(for: [booking], preferences: ReminderPreferences(enabled: true, leadMinutes: [0, -5, 60, 60, 99_999]), now: now, deviceZone: uk)
        XCTAssertEqual(plan.map(\.identifier), ["kt.reminder.s#0#60"])
    }

    func testBodyShowsUKTimeAndLocalTimeAbroad() {
        let booking = Fixture.booking("b", sessions: [Fixture.session("s", start: now.addingTimeInterval(86_400))])
        let atHome = ReminderPlanner.plan(for: [booking], preferences: on, now: now, deviceZone: uk)[0].body
        XCTAssertEqual(atHome, "Starts in 1 hour: Fri 15 Jan 2027, 18:00–19:00 UK time (GMT)")
        let abroad = ReminderPlanner.plan(for: [booking], preferences: on, now: now, deviceZone: TimeZone(identifier: "Europe/Paris")!)[0].body
        XCTAssertTrue(abroad.contains("\nYour time: Sat 16 Jan, 09:00–10:00"), abroad)
    }

    func testLeadTimesAreAbsoluteAcrossTheClockChange() {
        // Session at 18:00 BST on Sunday 28 March 2027 (17:00 UTC), the day the clocks go forward.
        let start = Date(timeIntervalSince1970: 1_806_253_200)
        let booking = Fixture.booking("b", sessions: [Fixture.session("s", start: start)])
        let plan = ReminderPlanner.plan(for: [booking], preferences: ReminderPreferences(enabled: true, leadMinutes: [1440]), now: now, deviceZone: uk)
        XCTAssertEqual(plan.first?.fireDate, start.addingTimeInterval(-86_400))
    }
}

final class TimeDisplayTests: XCTestCase {
    // Tue 24 Nov 2026 18:00–19:00 GMT
    let start = Date(timeIntervalSince1970: 1_795_543_200)
    var end: Date { start.addingTimeInterval(3_600) }

    func testSameAsUKTimeShowsNothingExtra() {
        XCTAssertNil(TimeDisplay.localText(start: start, end: end, in: TimeZone(identifier: "Europe/London")!))
        XCTAssertNil(TimeDisplay.localText(start: start, end: end, in: TimeZone(identifier: "Europe/Lisbon")!))
        XCTAssertNil(TimeDisplay.localText(start: start, end: end, in: TimeZone(secondsFromGMT: 0)!))
    }

    func testOtherZonesShowTheirOwnTime() {
        XCTAssertEqual(TimeDisplay.localText(start: start, end: end, in: TimeZone(identifier: "Europe/Warsaw")!), "Your time: Tue 24 Nov, 19:00–20:00")
        XCTAssertEqual(TimeDisplay.localText(start: start, end: end, in: TimeZone(identifier: "America/New_York")!), "Your time: Tue 24 Nov, 13:00–14:00")
        XCTAssertEqual(TimeDisplay.localText(start: start, end: end, in: TimeZone(identifier: "Asia/Kolkata")!), "Your time: Tue 24 Nov, 23:30–Wed 25 Nov, 00:30")
        XCTAssertEqual(TimeDisplay.localText(start: start, end: end, in: TimeZone(identifier: "Asia/Tokyo")!), "Your time: Wed 25 Nov, 03:00–04:00")
    }

    func testSummerTimeComparisonUsesTheDateOfTheClass() {
        // 1 Jul 2027 17:00 UTC = 18:00 BST. Dublin is also on summer time then, so no extra line.
        let summer = Date(timeIntervalSince1970: 1_814_461_200)
        XCTAssertNil(TimeDisplay.localText(start: summer, end: summer.addingTimeInterval(3_600), in: TimeZone(identifier: "Europe/Dublin")!))
        // A fixed GMT+0 zone differs from BST in summer.
        XCTAssertEqual(TimeDisplay.localText(start: summer, end: summer.addingTimeInterval(3_600), in: TimeZone(secondsFromGMT: 0)!), "Your time: Thu 1 Jul, 17:00–18:00")
    }

    func testRelativeLeadWording() {
        XCTAssertEqual(TimeDisplay.relativeLead(minutes: 1), "in 1 minute")
        XCTAssertEqual(TimeDisplay.relativeLead(minutes: 15), "in 15 minutes")
        XCTAssertEqual(TimeDisplay.relativeLead(minutes: 60), "in 1 hour")
        XCTAssertEqual(TimeDisplay.relativeLead(minutes: 120), "in 2 hours")
        XCTAssertEqual(TimeDisplay.relativeLead(minutes: 90), "in 1 h 30 min")
        XCTAssertEqual(TimeDisplay.relativeLead(minutes: 1440), "tomorrow")
        XCTAssertEqual(TimeDisplay.relativeLead(minutes: 2880), "in 2 days")
    }
}

final class PersistenceTests: XCTestCase {
    func tempURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("kt-tests-\(UUID().uuidString)/nested/bookings.json")
    }

    func testRoundTripCreatesFoldersAndPreservesEverything() throws {
        let url = tempURL()
        let cache = FileBookingCache(url: url)
        XCTAssertEqual(cache.load(), [])
        let booking = Fixture.booking("bk_1", sessions: [Fixture.session("s", start: Fixture.now), Fixture.session("t", start: Fixture.now.addingTimeInterval(60), number: nil, cancelled: true, meeting: nil)])
        try cache.save([booking])
        XCTAssertEqual(FileBookingCache(url: url).load(), [booking])
        let raw = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(raw.contains("token"), "the cache must never contain access tokens")
    }

    func testCorruptCacheIsDiscardedInsteadOfCrashing() throws {
        let url = tempURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{\"version\":1,\"bookings\":[{\"id\":".utf8).write(to: url)
        XCTAssertEqual(FileBookingCache(url: url).load(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
