import Foundation
@testable import KingstonTutoringCore

/// Records requests and answers them with a closure (or throws to simulate being offline).
final class MockTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [HTTPRequest] = []
    private var handler: (HTTPRequest) throws -> HTTPResponse

    init(_ handler: @escaping (HTTPRequest) throws -> HTTPResponse) { self.handler = handler }

    func setHandler(_ handler: @escaping (HTTPRequest) throws -> HTTPResponse) {
        lock.lock(); defer { lock.unlock() }
        self.handler = handler
    }

    var requests: [HTTPRequest] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        try record(request)(request)
    }

    /// Records and answers synchronously (used by GatedTransport).
    func answer(_ request: HTTPRequest) throws -> HTTPResponse {
        try record(request)(request)
    }

    /// Synchronous so the lock is never held across an await.
    private func record(_ request: HTTPRequest) -> (HTTPRequest) throws -> HTTPResponse {
        lock.lock(); defer { lock.unlock() }
        recorded.append(request)
        return handler
    }
}

struct SimulatedOffline: Error {}

enum Fixture {
    static let baseURL = URL(string: "https://kt.example")!
    /// 2027-01-15 08:00:00 UTC
    static let now = Date(timeIntervalSince1970: 1_800_000_000)

    static func token(_ character: Character) -> String { String(repeating: character, count: 43) }

    static func session(_ uid: String, start: Date, minutes: Int = 60, number: Int? = 1, of: Int = 1, sequence: Int = 0, cancelled: Bool = false, meeting: String? = "https://meet.example.com/abc") -> ClassSession {
        ClassSession(uid: uid, sequence: sequence, number: number, of: of, startsAt: start, endsAt: start.addingTimeInterval(TimeInterval(minutes * 60)), cancelled: cancelled, meetingUrl: meeting, ukDate: "Fri 15 Jan 2027", ukTime: "18:00–19:00 UK time (GMT)")
    }

    static func booking(_ id: String, status: BookingStatus = .confirmed, title: String? = nil, sessions: [ClassSession], groupCancelled: Bool = false, canCancel: Bool = true) -> Booking {
        Booking(id: id, status: status, title: title ?? "Class \(id)", topic: "Python test questions", firstName: "Ada", groupCancelled: groupCancelled, cancelReason: nil, sessions: sessions, canRequestCancellation: canCancel, cancelRequestedAt: nil, bookingPageUrl: "https://kt.example/booking/\(id)", updatedAt: now)
    }

    static func json(_ object: Any) -> HTTPResponse {
        HTTPResponse(status: 200, body: try! JSONSerialization.data(withJSONObject: object))
    }

    static func error(_ status: Int, _ code: String, _ message: String = "msg") -> HTTPResponse {
        HTTPResponse(status: status, body: try! JSONSerialization.data(withJSONObject: ["error": code, "message": message]))
    }

    /// A booking as the server serialises it (camelCase keys, epoch-second dates).
    static func bookingJSON(_ booking: Booking) -> [String: Any] {
        let data = try! JSONCoding.encoder().encode(booking)
        return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    static func body(_ request: HTTPRequest) -> [String: Any] {
        guard let data = request.body, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }
}

/// A one-way latch for async tests.
actor Latch {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }
}

/// Holds requests to one path in flight until released. The server answers first (so the reply reflects the
/// state when the request was made) and the reply is delivered only after `release`.
final class GatedTransport: HTTPTransport, @unchecked Sendable {
    let inner: HTTPTransport
    let path: String
    let arrived = Latch()
    let released = Latch()

    init(inner: HTTPTransport, path: String) {
        self.inner = inner
        self.path = path
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard request.url.path == path else { return try await inner.send(request) }
        let reply = Result { try answerNow(request) }
        await arrived.open()
        await released.wait()
        return try reply.get()
    }

    private func answerNow(_ request: HTTPRequest) throws -> HTTPResponse {
        // MockTransport answers synchronously, so a blocking bridge isn't needed: call its handler directly.
        guard let mock = inner as? MockTransport else { throw SimulatedOffline() }
        return try mock.answer(request)
    }
}
