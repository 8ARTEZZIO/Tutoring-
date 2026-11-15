import XCTest
@testable import KingstonTutoringCore

/// The debug-only demo mode must behave like the real server, so screenshots and App Review rehearsals
/// show real app behaviour.
@MainActor
final class DemoTransportTests: XCTestCase {
    private func makeLibrary(now: Date) -> (BookingLibrary, DemoTransport, InMemoryTokenStore) {
        let demo = DemoTransport(latency: 0, now: { now })
        let tokens = InMemoryTokenStore(demo.preloadedTokens)
        let library = BookingLibrary(api: APIClient(baseURL: DemoTransport.origin, transport: demo), tokens: tokens, cache: InMemoryBookingCache(), now: { now })
        return (library, demo, tokens)
    }

    func testStartsWithUpcomingPendingAndPastClasses() async throws {
        let now = Fixture.now
        let (library, _, _) = makeLibrary(now: now)
        XCTAssertTrue(library.bookings.isEmpty, "details arrive with the first refresh")
        try await library.refresh()
        let sections = bookingSections(library.bookings, now: now)
        XCTAssertEqual(sections.upcoming.map(\.id), ["bk_demo_pilot", "bk_demo_group", "bk_demo_saturday"])
        XCTAssertEqual(sections.past.map(\.id), ["bk_demo_past"])

        let group = try XCTUnwrap(library.booking(id: "bk_demo_group"))
        XCTAssertEqual(group.sessions.map(\.label), ["Session 1 of 4", "Session 2 of 4", "Session 3 of 4", "Session 4 of 4"])
        XCTAssertEqual(group.sessions[0].meetingURL?.host, "example.com")
        XCTAssertTrue(group.canRequestCancellation)

        let pending = try XCTUnwrap(library.booking(id: "bk_demo_saturday"))
        XCTAssertEqual(pending.status, .pending)
        XCTAssertTrue(pending.sessions.allSatisfy { $0.meetingURL == nil }, "no join links until payment is verified")
    }

    func testUKTimesAreWrittenLikeTheServerInWinterAndSummer() async throws {
        let winter = Fixture.now // Fri 15 Jan 2027, 08:00 UTC
        let (library, _, _) = makeLibrary(now: winter)
        try await library.refresh()
        let pilot = try XCTUnwrap(library.booking(id: "bk_demo_pilot")?.sessions.first)
        XCTAssertEqual(pilot.ukDate, "Sat 16 Jan 2027")
        XCTAssertEqual(pilot.ukTime, "18:00–19:00 UK time (GMT)")
        XCTAssertEqual(pilot.startsAt, Date(timeIntervalSince1970: 1_800_000_000 + 86_400 + 10 * 3_600))

        let summer = Date(timeIntervalSince1970: 1_814_428_800) // Thu 1 Jul 2027, 08:00 UTC
        let (summerLibrary, _, _) = makeLibrary(now: summer)
        try await summerLibrary.refresh()
        let summerPilot = try XCTUnwrap(summerLibrary.booking(id: "bk_demo_pilot")?.sessions.first)
        XCTAssertEqual(summerPilot.ukDate, "Fri 2 Jul 2027")
        XCTAssertEqual(summerPilot.ukTime, "18:00–19:00 UK time (BST)")
        XCTAssertEqual(summerPilot.startsAt, summer.addingTimeInterval(86_400 + 9 * 3_600), "18:00 BST is 17:00 UTC")
    }

    func testAddingTheDemoLinkWorksOnceAndBadLinksAreRefused() async throws {
        let (library, _, tokens) = makeLibrary(now: Fixture.now)
        try await library.refresh()
        let added = try await library.add(link: "Here it is: \(DemoTransport.addableLink).")
        XCTAssertEqual(added.id, "bk_demo_workshop")
        XCTAssertEqual(added.sessions.first?.ukTime, "17:00–18:30 UK time (GMT)")
        _ = try await library.add(link: DemoTransport.addableLink)
        XCTAssertEqual(library.bookings.filter { $0.id == "bk_demo_workshop" }.count, 1)
        XCTAssertEqual(tokens.tokens.count, 5)

        do {
            _ = try await library.add(link: "please add my class")
            XCTFail("expected notALink")
        } catch {
            XCTAssertEqual(error as? APIError, .notALink)
        }
        do {
            _ = try await library.add(link: "https://demo.invalid/b/" + String(repeating: "z", count: 43))
            XCTFail("expected linkNotValid")
        } catch {
            XCTAssertEqual(error as? APIError, .linkNotValid)
        }
    }

    func testCancellationRequestsFollowTheServerRules() async throws {
        let now = Fixture.now
        let (library, _, _) = makeLibrary(now: now)
        try await library.refresh()
        let requested = try await library.requestCancellation(bookingId: "bk_demo_group", note: "Exam clash")
        XCTAssertEqual(requested.cancelRequestedAt, now)
        XCTAssertFalse(requested.canRequestCancellation)
        for id in ["bk_demo_group", "bk_demo_saturday", "bk_demo_past"] {
            do {
                _ = try await library.requestCancellation(bookingId: id, note: "")
                XCTFail("expected notCancellable for \(id)")
            } catch {
                XCTAssertEqual(error as? APIError, .notCancellable, id)
            }
        }
        try await library.refresh()
        XCTAssertEqual(library.booking(id: "bk_demo_group")?.cancelRequestedAt, now, "the request survives a refresh")
    }

    func testRemovingSwitchesTheKeyOffAndRemindersCoverOnlyConfirmedFutureClasses() async throws {
        let now = Fixture.now
        let (library, demo, _) = makeLibrary(now: now)
        try await library.refresh()
        let plan = ReminderPlanner.plan(for: library.bookings, preferences: ReminderPreferences(enabled: true, leadMinutes: [60]), now: now, deviceZone: TimeDisplay.uk)
        XCTAssertEqual(plan.count, 5, "four group sessions and the pilot; not the pending or past booking")

        let removedKey = try XCTUnwrap(demo.preloadedTokens.first { $0.bookingId == "bk_demo_pilot" }?.token)
        await library.remove(bookingId: "bk_demo_pilot")
        let results = try await APIClient(baseURL: DemoTransport.origin, transport: demo).refresh(tokens: [removedKey])
        XCTAssertEqual(results, [.revoked])
        try await library.refresh()
        XCTAssertNil(library.booking(id: "bk_demo_pilot"))
    }

    func testConfigDecodes() async throws {
        let demo = DemoTransport(latency: 0)
        let config = try await APIClient(baseURL: DemoTransport.origin, transport: demo).config()
        XCTAssertEqual(config.apiVersion, 1)
        XCTAssertEqual(config.supportEmail, "support@example.com")
        XCTAssertFalse(config.cancellationSummary.isEmpty)
    }
}
