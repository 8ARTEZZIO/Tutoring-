import XCTest
@testable import KingstonTutoringCore

/// A tiny in-memory "server" for the library tests.
final class FakeServer: @unchecked Sendable {
    private let lock = NSLock()
    var bookingsByToken: [String: Booking] = [:]
    var linkToBooking: [String: Booking] = [:]
    var forgotten: [String] = []
    var offline = false
    private var counter = 0

    func handle(_ request: HTTPRequest) throws -> HTTPResponse {
        lock.lock(); defer { lock.unlock() }
        if offline { throw SimulatedOffline() }
        let body = Fixture.body(request)
        switch request.url.path {
        case "/api/app/v1/link":
            guard let token = LinkParser.token(in: body["link"] as? String ?? "") else { return Fixture.error(400, "not_a_link") }
            guard let booking = linkToBooking[token] else { return Fixture.error(404, "link_not_valid") }
            counter += 1
            let device = String(format: "dev%040d", counter)
            bookingsByToken[device] = booking
            return Fixture.json(["token": device, "booking": Fixture.bookingJSON(booking)])
        case "/api/app/v1/bookings":
            let tokens = body["tokens"] as? [String] ?? []
            let results: [[String: Any]] = tokens.map { t in
                if let b = bookingsByToken[t] { return ["ok": true, "booking": Fixture.bookingJSON(b)] }
                return ["ok": false, "error": "revoked"]
            }
            return Fixture.json(["results": results])
        case "/api/app/v1/forget":
            if let t = body["token"] as? String {
                forgotten.append(t)
                bookingsByToken[t] = nil
            }
            return Fixture.json(["ok": true])
        case "/api/app/v1/cancel-request":
            guard let t = body["token"] as? String, let b = bookingsByToken[t] else { return Fixture.error(404, "not_found") }
            let updated = Booking(id: b.id, status: b.status, title: b.title, topic: b.topic, firstName: b.firstName, groupCancelled: false, cancelReason: nil, sessions: b.sessions, canRequestCancellation: false, cancelRequestedAt: Fixture.now, bookingPageUrl: b.bookingPageUrl, updatedAt: Fixture.now)
            for (key, value) in bookingsByToken where value.id == b.id { bookingsByToken[key] = updated }
            return Fixture.json(["booking": Fixture.bookingJSON(updated)])
        default:
            return Fixture.error(404, "not_found")
        }
    }

    /// Replace a booking's server-side state for every device holding it.
    func update(_ booking: Booking) {
        lock.lock(); defer { lock.unlock() }
        for (key, value) in bookingsByToken where value.id == booking.id { bookingsByToken[key] = booking }
    }

    func revokeAll(bookingId: String) {
        lock.lock(); defer { lock.unlock() }
        for (key, value) in bookingsByToken where value.id == bookingId { bookingsByToken[key] = nil }
    }
}

@MainActor
final class BookingLibraryTests: XCTestCase {
    var server: FakeServer!
    var tokens: InMemoryTokenStore!
    var cache: InMemoryBookingCache!
    var transport: MockTransport!

    override func setUp() async throws {
        server = FakeServer()
        tokens = InMemoryTokenStore()
        cache = InMemoryBookingCache()
        let server = self.server!
        transport = MockTransport { try server.handle($0) }
    }

    func makeLibrary() -> BookingLibrary {
        BookingLibrary(api: APIClient(baseURL: Fixture.baseURL, transport: transport), tokens: tokens, cache: cache, now: { Fixture.now })
    }

    func seed(_ id: String, link: Character, start: TimeInterval = 86_400) -> Booking {
        let booking = Fixture.booking(id, sessions: [Fixture.session("\(id)-1", start: Fixture.now.addingTimeInterval(start))])
        server.linkToBooking[Fixture.token(link)] = booking
        return booking
    }

    func testAddPersistsAndSurvivesARestartOffline() async throws {
        _ = seed("bk_1", link: "a")
        let library = makeLibrary()
        try await library.add(link: "https://kt.example/b/\(Fixture.token("a"))")
        XCTAssertEqual(library.bookings.map(\.id), ["bk_1"])
        XCTAssertEqual(tokens.tokens.count, 1)
        XCTAssertEqual(cache.bookings.map(\.id), ["bk_1"])
        // Restart with no network: saved details are shown.
        server.offline = true
        let restarted = makeLibrary()
        XCTAssertEqual(restarted.bookings.map(\.id), ["bk_1"])
        do {
            try await restarted.refresh()
            XCTFail("expected offline")
        } catch {
            XCTAssertEqual(error as? APIError, .offline)
        }
        XCTAssertEqual(restarted.bookings.map(\.id), ["bk_1"], "network failure must never drop saved bookings")
    }

    func testRejectsTextThatIsNotALinkWithoutCallingTheServer() async {
        let library = makeLibrary()
        do {
            try await library.add(link: "my booking please")
            XCTFail("expected notALink")
        } catch {
            XCTAssertEqual(error as? APIError, .notALink)
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testAddingTheSameBookingTwiceKeepsOneCopyAndRetiresTheOldKey() async throws {
        _ = seed("bk_1", link: "a")
        server.linkToBooking[Fixture.token("b")] = server.linkToBooking[Fixture.token("a")]
        let library = makeLibrary()
        try await library.add(link: Fixture.token("a"))
        let firstKey = tokens.tokens[0].token
        try await library.add(link: Fixture.token("b"))
        XCTAssertEqual(library.bookings.count, 1)
        XCTAssertEqual(tokens.tokens.count, 1)
        XCTAssertNotEqual(tokens.tokens[0].token, firstKey)
        XCTAssertEqual(server.forgotten, [firstKey])
    }

    func testRefreshUpdatesStateAndRemovesRevokedBookings() async throws {
        let one = seed("bk_1", link: "a")
        _ = seed("bk_2", link: "b")
        let library = makeLibrary()
        try await library.add(link: Fixture.token("a"))
        try await library.add(link: Fixture.token("b"))
        let rescheduled = Fixture.booking("bk_1", title: "Renamed", sessions: [Fixture.session("bk_1-1", start: Fixture.now.addingTimeInterval(172_800), sequence: 1)])
        server.update(rescheduled)
        server.revokeAll(bookingId: "bk_2")
        let outcome = try await library.refresh()
        XCTAssertEqual(outcome.removedTitles, ["Class bk_2"])
        XCTAssertEqual(library.bookings.map(\.id), ["bk_1"])
        XCTAssertEqual(library.bookings.first?.title, "Renamed")
        XCTAssertEqual(library.bookings.first?.sessions.first?.sequence, 1)
        XCTAssertEqual(library.lastRefreshed, Fixture.now)
        XCTAssertNotEqual(one.title, "Renamed")
        XCTAssertEqual(cache.bookings.map(\.id), ["bk_1"])
    }

    /// A refresh reply that was computed before changes made on the phone must not undo them.
    func testChangesMadeWhileARefreshIsInFlightAreKept() async throws {
        _ = seed("bk_1", link: "a")
        _ = seed("bk_2", link: "b")
        _ = seed("bk_3", link: "c")
        _ = seed("bk_4", link: "e")
        server.linkToBooking[Fixture.token("d")] = server.linkToBooking[Fixture.token("a")]
        let gated = GatedTransport(inner: transport, path: "/api/app/v1/bookings")
        let library = BookingLibrary(api: APIClient(baseURL: Fixture.baseURL, transport: gated), tokens: tokens, cache: cache, now: { Fixture.now })
        try await library.add(link: Fixture.token("a"))
        try await library.add(link: Fixture.token("b"))
        try await library.add(link: Fixture.token("e"))

        let refresh = Task { try await library.refresh() }
        await gated.arrived.wait()
        // While the reply is in flight: bk_1 gets a new key, bk_2 is removed, bk_3 is added and
        // bk_4 gets a cancellation request.
        try await library.add(link: Fixture.token("d"))
        let newKey = try XCTUnwrap(tokens.tokens.first { $0.bookingId == "bk_1" }?.token)
        await library.remove(bookingId: "bk_2")
        try await library.add(link: Fixture.token("c"))
        _ = try await library.requestCancellation(bookingId: "bk_4", note: "")
        await gated.released.open()

        let outcome = try await refresh.value
        XCTAssertEqual(outcome.removedTitles, [], "a key replaced mid-flight is not reported as removed")
        XCTAssertEqual(library.bookings.map(\.id), ["bk_1", "bk_4", "bk_3"])
        XCTAssertEqual(tokens.tokens.first { $0.bookingId == "bk_1" }?.token, newKey)
        XCTAssertEqual(library.booking(id: "bk_4")?.cancelRequestedAt, Fixture.now, "the older reply doesn't hide the request")

        // The next refresh sees the live keys and keeps everything.
        let next = try await library.refresh()
        XCTAssertEqual(next.removedTitles, [])
        XCTAssertEqual(library.bookings.map(\.id), ["bk_1", "bk_4", "bk_3"])
        XCTAssertEqual(cache.bookings.map(\.id), ["bk_1", "bk_4", "bk_3"])
    }

    func testTwoRefreshesAtOnceLeaveOneCopyOfEachBooking() async throws {
        _ = seed("bk_1", link: "a")
        _ = seed("bk_2", link: "b")
        let library = makeLibrary()
        try await library.add(link: Fixture.token("a"))
        try await library.add(link: Fixture.token("b"))
        async let first = library.refresh()
        async let second = library.refresh()
        _ = try await (first, second)
        XCTAssertEqual(library.bookings.map(\.id), ["bk_1", "bk_2"])
        XCTAssertEqual(tokens.tokens.count, 2)
    }

    func testRefreshWithNothingAddedMakesNoRequest() async throws {
        let library = makeLibrary()
        let outcome = try await library.refresh()
        XCTAssertEqual(outcome.removedTitles, [])
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testRemoveWorksOfflineAndSwitchesTheKeyOffWhenOnline() async throws {
        _ = seed("bk_1", link: "a")
        _ = seed("bk_2", link: "b")
        let library = makeLibrary()
        try await library.add(link: Fixture.token("a"))
        try await library.add(link: Fixture.token("b"))
        let keyB = tokens.tokens[1].token
        await library.remove(bookingId: "bk_2")
        XCTAssertEqual(server.forgotten, [keyB])
        server.offline = true
        await library.remove(bookingId: "bk_1")
        XCTAssertTrue(library.bookings.isEmpty)
        XCTAssertTrue(tokens.tokens.isEmpty)
        XCTAssertTrue(cache.bookings.isEmpty)
        await library.remove(bookingId: "does-not-exist")
    }

    func testRequestCancellationUpdatesTheBooking() async throws {
        _ = seed("bk_1", link: "a")
        let library = makeLibrary()
        try await library.add(link: Fixture.token("a"))
        let updated = try await library.requestCancellation(bookingId: "bk_1", note: "Exam clash")
        XCTAssertFalse(updated.canRequestCancellation)
        XCTAssertEqual(library.booking(id: "bk_1")?.cancelRequestedAt, Fixture.now)
        do {
            _ = try await library.requestCancellation(bookingId: "nope", note: "")
            XCTFail("expected notFound")
        } catch {
            XCTAssertEqual(error as? APIError, .notFound)
        }
    }

    func testStartupDropsDuplicateKeysAndStaleCacheEntries() {
        tokens.tokens = [
            StoredToken(bookingId: "bk_1", token: Fixture.token("a"), addedAt: Fixture.now),
            StoredToken(bookingId: "bk_1", token: Fixture.token("b"), addedAt: Fixture.now),
            StoredToken(bookingId: "bk_3", token: Fixture.token("c"), addedAt: Fixture.now),
        ]
        cache.bookings = [Fixture.booking("bk_1", sessions: []), Fixture.booking("bk_2", sessions: [])]
        let library = makeLibrary()
        XCTAssertEqual(library.bookings.map(\.id), ["bk_1"], "bk_2 has no key; bk_3 has no details yet")
        XCTAssertFalse(library.isEmpty)
    }

    func testSectionsOrderUpcomingBySoonestAndPastByLatest() {
        let now = Fixture.now
        let soon = Fixture.booking("soon", sessions: [Fixture.session("s1", start: now.addingTimeInterval(3_600))])
        let later = Fixture.booking("later", sessions: [Fixture.session("l1", start: now.addingTimeInterval(86_400))])
        let pending = Fixture.booking("pending", status: .pending, sessions: [Fixture.session("p1", start: now.addingTimeInterval(7_200))])
        let inProgress = Fixture.booking("live", sessions: [Fixture.session("i1", start: now.addingTimeInterval(-1_800))])
        let finished = Fixture.booking("done", sessions: [Fixture.session("d1", start: now.addingTimeInterval(-86_400))])
        let groupCancelled = Fixture.booking("gc", status: .cancelled, sessions: [Fixture.session("g1", start: now.addingTimeInterval(5_000), cancelled: true)], groupCancelled: true)
        let notBooked = Fixture.booking("nb", status: .notBooked, sessions: [Fixture.session("n1", start: now.addingTimeInterval(9_000))])
        let partlyCancelled = Fixture.booking("pc", sessions: [
            Fixture.session("pc1", start: now.addingTimeInterval(1_000), cancelled: true),
            Fixture.session("pc2", start: now.addingTimeInterval(50_000)),
        ])
        let sections = bookingSections([later, finished, soon, groupCancelled, pending, notBooked, inProgress, partlyCancelled], now: now)
        XCTAssertEqual(sections.upcoming.map(\.id), ["live", "soon", "pending", "pc", "later"])
        XCTAssertEqual(sections.past.map(\.id), ["nb", "gc", "done"])
        XCTAssertEqual(partlyCancelled.nextSession(after: now)?.uid, "pc2")
    }
}
