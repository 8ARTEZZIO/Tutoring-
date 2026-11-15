import Foundation

/// A self-contained stand-in for the booking server. The app uses it only in Debug builds launched with
/// `-KTDemo` (for screenshots and for trying the app without a deployed site). It speaks the same JSON API
/// as the real server, with fictional bookings placed relative to the current time.
public final class DemoTransport: HTTPTransport, @unchecked Sendable {
    public static let origin = URL(string: "https://demo.invalid")!
    /// A link that isn't on the phone yet, so "Add booking" can be tried.
    public static let addableLink = "https://demo.invalid/b/" + padded("DemoRevisionWorkshop")

    private let lock = NSLock()
    private var links: [String: String] = [:]
    private var deviceTokens: [String: String] = [:]
    private var bookings: [String: Booking] = [:]
    private var counter = 0
    private let latency: TimeInterval
    private let now: () -> Date
    /// Keys for the bookings that start out on the phone.
    public let preloadedTokens: [StoredToken]

    public init(latency: TimeInterval = 0.4, now: @escaping () -> Date = Date.init) {
        self.latency = latency
        self.now = now
        let start = now()
        let samples = DemoTransport.samples(now: start)
        var preloaded: [StoredToken] = []
        for (index, sample) in samples.enumerated() {
            bookings[sample.booking.id] = sample.booking
            links[DemoTransport.padded(sample.linkSeed)] = sample.booking.id
            if sample.preloaded {
                let token = DemoTransport.padded("DemoDevice\(index)")
                deviceTokens[token] = sample.booking.id
                preloaded.append(StoredToken(bookingId: sample.booking.id, token: token, addedAt: start))
            }
        }
        preloadedTokens = preloaded
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        if latency > 0 { try? await Task.sleep(nanoseconds: UInt64(latency * 1_000_000_000)) }
        return handle(request)
    }

    // MARK: The fake API

    private func handle(_ request: HTTPRequest) -> HTTPResponse {
        lock.lock(); defer { lock.unlock() }
        let body = request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        switch (request.method, request.url.path) {
        case ("POST", "/api/app/v1/link"):
            guard let token = LinkParser.token(in: body["link"] as? String ?? "") else { return error(400, "not_a_link") }
            guard let id = links[token], let booking = bookings[id] else { return error(404, "link_not_valid") }
            counter += 1
            let device = DemoTransport.padded("DemoIssued\(counter)")
            deviceTokens[device] = id
            return json(LinkReply(token: device, booking: booking))
        case ("POST", "/api/app/v1/bookings"):
            let tokens = body["tokens"] as? [String] ?? []
            let results = tokens.map { token -> RefreshItem in
                guard let id = deviceTokens[token], let booking = bookings[id] else { return RefreshItem(ok: false, booking: nil, error: "revoked") }
                return RefreshItem(ok: true, booking: booking, error: nil)
            }
            return json(RefreshReply(results: results))
        case ("POST", "/api/app/v1/cancel-request"):
            guard let token = body["token"] as? String, let id = deviceTokens[token], let booking = bookings[id] else { return error(404, "not_found") }
            guard booking.canRequestCancellation else { return error(409, "not_cancellable") }
            let updated = booking.with(canRequestCancellation: false, cancelRequestedAt: now())
            bookings[id] = updated
            return json(CancelReply(booking: updated))
        case ("POST", "/api/app/v1/forget"):
            if let token = body["token"] as? String { deviceTokens[token] = nil }
            return json(OkReply(ok: true))
        case ("GET", "/api/app/v1/config"):
            return json(AppConfig(
                apiVersion: 1,
                sellerName: "Demo Tutor (fictional)",
                supportEmail: "support@example.com",
                supportUrl: "https://example.com/support",
                privacyUrl: "https://example.com/privacy",
                termsUrl: "https://example.com/terms",
                cancellationSummary: "You can cancel within 14 days of booking for a full refund. If a date moves and you can't make the new time, or a class is cancelled, you'll get a full refund for the affected sessions."
            ))
        default:
            return error(404, "not_found")
        }
    }

    private func json<T: Encodable>(_ value: T) -> HTTPResponse {
        HTTPResponse(status: 200, body: (try? JSONCoding.encoder().encode(value)) ?? Data())
    }

    private func error(_ status: Int, _ code: String) -> HTTPResponse {
        json(ErrorReply(error: code, message: nil)).withStatus(status)
    }

    // MARK: Sample data (fictional)

    private struct Sample {
        let linkSeed: String
        let preloaded: Bool
        let booking: Booking
    }

    private static func samples(now: Date) -> [Sample] {
        let topic = "Python test questions"
        let group = (0..<4).map { week in session("demo-group-\(week)", day: 2 + week * 7, at: (18, 0), minutes: 60, now: now) }
        let pilot = [session("demo-pilot", day: 1, at: (18, 0), minutes: 60, now: now)]
        let saturday = (0..<4).map { week in session("demo-sat-\(week)", day: 4 + week * 7, at: (11, 0), minutes: 60, now: now) }
        let past = [session("demo-past", day: -6, at: (19, 0), minutes: 60, now: now)]
        let workshop = [session("demo-workshop", day: 5, at: (17, 0), minutes: 90, now: now)]
        return [
            Sample(linkSeed: "DemoFirstGroup", preloaded: true, booking: booking("bk_demo_group", .confirmed, "First four-session group", topic, numbered(group, meeting: "https://example.com/join/first-group"))),
            Sample(linkSeed: "DemoPythonPilot", preloaded: true, booking: booking("bk_demo_pilot", .confirmed, "Python pilot: turning test questions into code", topic, numbered(pilot, meeting: "https://example.com/join/python-pilot"))),
            Sample(linkSeed: "DemoSaturdayGroup", preloaded: true, booking: booking("bk_demo_saturday", .pending, "Later four-session group", topic, numbered(saturday, meeting: nil), canCancel: false)),
            Sample(linkSeed: "DemoWednesday", preloaded: true, booking: booking("bk_demo_past", .confirmed, "Wednesday evening group", topic, numbered(past, meeting: "https://example.com/join/wednesday"), canCancel: false)),
            Sample(linkSeed: "DemoRevisionWorkshop", preloaded: false, booking: booking("bk_demo_workshop", .confirmed, "Revision workshop", topic, numbered(workshop, meeting: "https://example.com/join/revision"))),
        ]
    }

    private static func booking(_ id: String, _ status: BookingStatus, _ title: String, _ topic: String, _ sessions: [ClassSession], canCancel: Bool = true) -> Booking {
        Booking(id: id, status: status, title: title, topic: topic, firstName: "Sam", groupCancelled: false, cancelReason: nil, sessions: sessions, canRequestCancellation: canCancel, cancelRequestedAt: nil, bookingPageUrl: "https://demo.invalid/booking/\(id)", updatedAt: Date(timeIntervalSince1970: 0))
    }

    private struct Slot {
        let uid: String
        let start: Date
        let end: Date
    }

    /// A class `day` days from today at a UK wall-clock time.
    private static func session(_ uid: String, day: Int, at time: (hour: Int, minute: Int), minutes: Int, now: Date) -> Slot {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeDisplay.uk
        let today = calendar.startOfDay(for: now)
        let date = calendar.date(byAdding: .day, value: day, to: today)!
        let start = calendar.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: date)!
        return Slot(uid: uid, start: start, end: start.addingTimeInterval(TimeInterval(minutes * 60)))
    }

    private static func numbered(_ slots: [Slot], meeting: String?) -> [ClassSession] {
        slots.enumerated().map { index, slot in
            ClassSession(uid: slot.uid, sequence: 0, number: index + 1, of: slots.count, startsAt: slot.start, endsAt: slot.end, cancelled: false, meetingUrl: meeting, ukDate: ukDate(slot.start), ukTime: ukTime(slot.start, slot.end))
        }
    }

    /// "Tue 24 Nov 2026", as the server writes it.
    static func ukDate(_ date: Date) -> String {
        TimeDisplay.formatter("EEE d MMM yyyy", TimeDisplay.uk).string(from: date)
    }

    /// "18:00–19:00 UK time (GMT)", as the server writes it.
    static func ukTime(_ start: Date, _ end: Date) -> String {
        let time = TimeDisplay.formatter("HH:mm", TimeDisplay.uk)
        let zone = { (date: Date) in TimeDisplay.uk.secondsFromGMT(for: date) == 3600 ? "BST" : "GMT" }
        if zone(start) == zone(end) {
            return "\(time.string(from: start))–\(time.string(from: end)) UK time (\(zone(start)))"
        }
        return "\(time.string(from: start)) \(zone(start))–\(time.string(from: end)) \(zone(end)) (UK time)"
    }

    static func padded(_ seed: String) -> String {
        String((seed + String(repeating: "x", count: LinkParser.tokenLength)).prefix(LinkParser.tokenLength))
    }
}

private struct LinkReply: Encodable { let token: String; let booking: Booking }
private struct RefreshItem: Encodable { let ok: Bool; let booking: Booking?; let error: String? }
private struct RefreshReply: Encodable { let results: [RefreshItem] }
private struct CancelReply: Encodable { let booking: Booking }
private struct OkReply: Encodable { let ok: Bool }
private struct ErrorReply: Encodable { let error: String; let message: String? }

extension Booking {
    func with(canRequestCancellation: Bool, cancelRequestedAt: Date?) -> Booking {
        Booking(id: id, status: status, title: title, topic: topic, firstName: firstName, groupCancelled: groupCancelled, cancelReason: cancelReason, sessions: sessions, canRequestCancellation: canRequestCancellation, cancelRequestedAt: cancelRequestedAt, bookingPageUrl: bookingPageUrl, updatedAt: updatedAt)
    }
}

extension HTTPResponse {
    func withStatus(_ status: Int) -> HTTPResponse { HTTPResponse(status: status, body: body) }
}
