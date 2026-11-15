import XCTest
@testable import KingstonTutoringCore

/// Runs the real URLSession client against a running server. Skipped unless both variables are set, e.g.
///   KT_CONTRACT_BASE_URL=http://localhost:8787 KT_CONTRACT_LINK=http://localhost:8787/b/<token> swift test
/// It adds the booking, refreshes it and removes it again (the emailed link keeps working). Set
/// KT_CONTRACT_REQUEST_CANCELLATION=1 to also send a cancellation request, which the tutor will see:
/// only do that with a demo booking.
@MainActor
final class ContractTests: XCTestCase {
    func testFullLifecycleAgainstARealServer() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let base = env["KT_CONTRACT_BASE_URL"].flatMap(URL.init(string:)), let link = env["KT_CONTRACT_LINK"] else {
            throw XCTSkip("Set KT_CONTRACT_BASE_URL and KT_CONTRACT_LINK to run against a server")
        }
        let api = APIClient(baseURL: base, transport: URLSessionTransport(timeout: 10), userAgent: "KingstonTutoring-ContractTest")
        let config = try await api.config()
        XCTAssertEqual(config.apiVersion, 1)
        XCTAssertTrue(config.privacyUrl.contains("/privacy"))
        XCTAssertTrue(config.supportUrl.hasSuffix("/support?view=app"), "the app opens the app view of support pages")

        let tokens = InMemoryTokenStore()
        let cache = InMemoryBookingCache()
        let library = BookingLibrary(api: api, tokens: tokens, cache: cache)
        let booking = try await library.add(link: "Here is my link: \(link) — thanks!")
        XCTAssertEqual(booking.status, .confirmed)
        XCTAssertFalse(booking.sessions.isEmpty)
        for session in booking.sessions where !session.cancelled {
            XCTAssertNotNil(session.meetingURL, "confirmed sessions carry an https join link")
            XCTAssertTrue(session.ukTime.contains("UK time"))
            XCTAssertGreaterThan(session.endsAt, session.startsAt)
        }
        // Adding again keeps one copy.
        try await library.add(link: link)
        XCTAssertEqual(library.bookings.count, 1)
        let outcome = try await library.refresh()
        XCTAssertEqual(outcome.removedTitles, [])
        XCTAssertEqual(library.bookings.first?.id, booking.id)

        let plan = ReminderPlanner.plan(for: library.bookings, preferences: ReminderPreferences(enabled: true, leadMinutes: [60]), now: Date(), deviceZone: TimeZone(identifier: "Europe/Paris")!)
        XCTAssertFalse(plan.isEmpty)

        if booking.canRequestCancellation && env["KT_CONTRACT_REQUEST_CANCELLATION"] == "1" {
            let updated = try await library.requestCancellation(bookingId: booking.id, note: "Contract test: please ignore")
            XCTAssertFalse(updated.canRequestCancellation)
            XCTAssertNotNil(updated.cancelRequestedAt)
        }

        // Unknown links and garbage are rejected with the right errors.
        do {
            _ = try await api.addBooking(link: "\(base.absoluteString)/b/\(String(repeating: "Z", count: 43))")
            XCTFail("expected linkNotValid")
        } catch {
            XCTAssertEqual(error as? APIError, .linkNotValid)
        }

        // Removing switches the device key off on the server.
        let key = tokens.tokens[0].token
        await library.remove(bookingId: booking.id)
        XCTAssertTrue(library.bookings.isEmpty)
        let afterRemoval = try await api.refresh(tokens: [key])
        XCTAssertEqual(afterRemoval, [.revoked])
    }
}
