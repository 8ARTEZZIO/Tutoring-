import XCTest
@testable import KingstonTutoringCore

final class APIClientTests: XCTestCase {
    func client(_ transport: MockTransport) -> APIClient {
        APIClient(baseURL: Fixture.baseURL, transport: transport, userAgent: "Test/1")
    }

    func testAddBookingSendsTheLinkAndDecodesTheServerShape() async throws {
        // Literal JSON in the exact shape the Worker returns (see src/public/api.ts).
        let json = """
        {"token":"\(Fixture.token("d"))","booking":{"id":"bk_abc","status":"confirmed","title":"First four-session group",
        "topic":"Python test questions","firstName":"Ada","groupCancelled":false,"cancelReason":null,
        "sessions":[{"uid":"les_1@kingston-tutoring","sequence":0,"number":1,"of":2,"startsAt":1800000000,"endsAt":1800003600,
        "cancelled":false,"meetingUrl":"https://meet.example.com/x","ukDate":"Fri 15 Jan 2027","ukTime":"08:00–09:00 UK time (GMT)"},
        {"uid":"les_2@kingston-tutoring","sequence":2,"number":null,"of":2,"startsAt":1800604800,"endsAt":1800608400,
        "cancelled":true,"meetingUrl":null,"ukDate":"Fri 22 Jan 2027","ukTime":"08:00–09:00 UK time (GMT)","futureField":true}],
        "canRequestCancellation":true,"cancelRequestedAt":null,"bookingPageUrl":"https://kt.example/booking/bk_abc","updatedAt":1799990000,
        "someNewField":{"nested":1}}}
        """
        let transport = MockTransport { _ in HTTPResponse(status: 200, body: Data(json.utf8)) }
        let (token, booking) = try await client(transport).addBooking(link: "https://kt.example/b/\(Fixture.token("a"))")
        XCTAssertEqual(token, Fixture.token("d"))
        XCTAssertEqual(booking.status, .confirmed)
        XCTAssertEqual(booking.sessions.count, 2)
        XCTAssertEqual(booking.sessions[0].startsAt, Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertEqual(booking.sessions[0].meetingURL?.host, "meet.example.com")
        XCTAssertNil(booking.sessions[1].number)
        XCTAssertEqual(booking.sessions[1].label, "Cancelled")
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "https://kt.example/api/app/v1/link")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(request.headers["User-Agent"], "Test/1")
        XCTAssertEqual(Fixture.body(request)["link"] as? String, "https://kt.example/b/\(Fixture.token("a"))")
    }

    func testUnknownStatusDoesNotBreakDecoding() async throws {
        var object = Fixture.bookingJSON(Fixture.booking("bk_1", sessions: []))
        object["status"] = "waitlisted_in_future"
        let transport = MockTransport { _ in Fixture.json(["token": Fixture.token("t"), "booking": object]) }
        let (_, booking) = try await client(transport).addBooking(link: Fixture.token("a"))
        XCTAssertEqual(booking.status, .unknown)
    }

    func testRefreshSendsAtMostTwentyTokensPerRequestAndKeepsOrder() async throws {
        let tokens = (0..<45).map { i in String(format: "%043d", i) }
        let transport = MockTransport { request in
            let sent = Fixture.body(request)["tokens"] as! [String]
            XCTAssertLessThanOrEqual(sent.count, 20)
            let results: [[String: Any]] = sent.map { t in
                Int(t)! % 3 == 0
                    ? ["ok": true, "booking": Fixture.bookingJSON(Fixture.booking("bk_\(Int(t)!)", sessions: []))]
                    : ["ok": false, "error": Int(t)! % 3 == 1 ? "revoked" : "invalid"]
            }
            return Fixture.json(["results": results, "serverTime": 1])
        }
        let results = try await client(transport).refresh(tokens: tokens)
        XCTAssertEqual(transport.requests.count, 3)
        XCTAssertEqual(results.count, 45)
        for (i, result) in results.enumerated() {
            switch i % 3 {
            case 0:
                guard case .booking(let b) = result else { return XCTFail("index \(i)") }
                XCTAssertEqual(b.id, "bk_\(i)")
            case 1: XCTAssertEqual(result, .revoked)
            default: XCTAssertEqual(result, .invalid)
            }
        }
    }

    func testRefreshWithNoTokensMakesNoRequest() async throws {
        let transport = MockTransport { _ in XCTFail("no request expected"); return Fixture.json([:]) }
        let results = try await client(transport).refresh(tokens: [])
        XCTAssertEqual(results, [])
        XCTAssertEqual(transport.requests.count, 0)
    }

    func testRefreshRejectsAMismatchedResultCount() async {
        let transport = MockTransport { _ in Fixture.json(["results": [["ok": false, "error": "revoked"]]]) }
        do {
            _ = try await client(transport).refresh(tokens: [Fixture.token("a"), Fixture.token("b")])
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? APIError, .invalidResponse)
        }
    }

    func testErrorMapping() async {
        let cases: [(HTTPResponse, APIError)] = [
            (Fixture.error(400, "not_a_link"), .notALink),
            (Fixture.error(404, "link_not_valid"), .linkNotValid),
            (Fixture.error(404, "not_found"), .notFound),
            (Fixture.error(409, "not_cancellable"), .notCancellable),
            (Fixture.error(429, "rate_limited"), .rateLimited),
            (Fixture.error(500, "boom", "Server is sad"), .server(status: 500, message: "Server is sad")),
            (HTTPResponse(status: 502, body: Data("<html>Bad gateway</html>".utf8)), .server(status: 502, message: nil)),
            (HTTPResponse(status: 200, body: Data("not json".utf8)), .invalidResponse),
            (HTTPResponse(status: 200, body: Data("{}".utf8)), .invalidResponse),
        ]
        for (response, expected) in cases {
            let transport = MockTransport { _ in response }
            do {
                _ = try await client(transport).addBooking(link: Fixture.token("a"))
                XCTFail("expected \(expected)")
            } catch {
                XCTAssertEqual(error as? APIError, expected)
            }
        }
        let offline = MockTransport { _ in throw SimulatedOffline() }
        do {
            _ = try await client(offline).config()
            XCTFail("expected offline")
        } catch {
            XCTAssertEqual(error as? APIError, .offline)
        }
    }

    func testEveryErrorHasAFriendlyMessage() {
        let all: [APIError] = [.offline, .notALink, .linkNotValid, .notFound, .notCancellable, .rateLimited, .server(status: 500, message: nil), .invalidResponse]
        for error in all { XCTAssertFalse(error.userMessage.isEmpty) }
        XCTAssertEqual(APIError.server(status: 503, message: "Down for maintenance").userMessage, "Down for maintenance")
    }

    func testOnlyHTTPSMeetingLinksAreUsable() {
        let start = Fixture.now
        XCTAssertNotNil(Fixture.session("a", start: start, meeting: "https://meet.google.com/abc-defg-hij").meetingURL)
        XCTAssertNil(Fixture.session("b", start: start, meeting: "http://meet.example.com/x").meetingURL)
        XCTAssertNil(Fixture.session("c", start: start, meeting: "javascript:alert(1)").meetingURL)
        XCTAssertNil(Fixture.session("d", start: start, meeting: "not a url").meetingURL)
        XCTAssertNil(Fixture.session("e", start: start, meeting: nil).meetingURL)
        XCTAssertNil(Fixture.session("f", start: start, meeting: "https://").meetingURL)
    }

    func testCancellationAndForgetRequests() async throws {
        let transport = MockTransport { request in
            if request.url.path.hasSuffix("cancel-request") {
                return Fixture.json(["booking": Fixture.bookingJSON(Fixture.booking("bk_1", sessions: [], canCancel: false))])
            }
            return Fixture.json(["ok": true])
        }
        let api = client(transport)
        let booking = try await api.requestCancellation(token: Fixture.token("a"), note: "Exam clash")
        XCTAssertFalse(booking.canRequestCancellation)
        try await api.forget(token: Fixture.token("a"))
        XCTAssertEqual(transport.requests.map(\.url.path), ["/api/app/v1/cancel-request", "/api/app/v1/forget"])
        XCTAssertEqual(Fixture.body(transport.requests[0])["note"] as? String, "Exam clash")
    }

    func testConfigIsAGetWithoutBody() async throws {
        let transport = MockTransport { _ in
            Fixture.json(["apiVersion": 1, "sellerName": NSNull(), "supportEmail": "help@example.com", "supportUrl": "https://kt.example/support",
                          "privacyUrl": "https://kt.example/privacy", "termsUrl": "https://kt.example/terms", "cancellationSummary": "You can cancel…"])
        }
        let config = try await client(transport).config()
        XCTAssertNil(config.sellerName)
        XCTAssertEqual(config.supportEmail, "help@example.com")
        XCTAssertEqual(transport.requests.first?.method, "GET")
        XCTAssertNil(transport.requests.first?.body)
    }
}
