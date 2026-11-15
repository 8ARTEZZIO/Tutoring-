import Foundation

/// Booking state as reported by the server. Unknown future values decode as `.unknown` instead of failing.
public enum BookingStatus: String, Codable, Sendable, CaseIterable {
    case confirmed
    case pending
    case review
    case cancelled
    case notBooked = "not_booked"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BookingStatus(rawValue: raw) ?? .unknown
    }

    public var label: String {
        switch self {
        case .confirmed: return "Confirmed"
        case .pending: return "Payment pending"
        case .review: return "Being checked"
        case .cancelled: return "Cancelled"
        case .notBooked: return "Not booked"
        case .unknown: return "Unknown"
        }
    }

    /// Extra explanation shown on the booking screen (nil when nothing needs saying).
    public var explanation: String? {
        switch self {
        case .confirmed: return nil
        case .pending: return "Your seat is held while your payment is confirmed. Join links appear here once it's verified."
        case .review: return "Your payment needs a quick manual check. Your seat is kept and you don't need to pay again."
        case .cancelled: return "This booking has been cancelled."
        case .notBooked: return "This checkout ended without payment, so nothing was charged."
        case .unknown: return "Pull down to refresh."
        }
    }
}

/// One class date. Times are absolute; `ukDate`/`ukTime` are the server's canonical UK-time strings.
public struct ClassSession: Codable, Hashable, Sendable, Identifiable {
    public var id: String { uid }
    public let uid: String
    public let sequence: Int
    /// Position among sessions that are still on; nil for a cancelled session.
    public let number: Int?
    public let of: Int
    public let startsAt: Date
    public let endsAt: Date
    public let cancelled: Bool
    public let meetingUrl: String?
    public let ukDate: String
    public let ukTime: String

    public init(uid: String, sequence: Int, number: Int?, of: Int, startsAt: Date, endsAt: Date, cancelled: Bool, meetingUrl: String?, ukDate: String, ukTime: String) {
        self.uid = uid
        self.sequence = sequence
        self.number = number
        self.of = of
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.cancelled = cancelled
        self.meetingUrl = meetingUrl
        self.ukDate = ukDate
        self.ukTime = ukTime
    }

    /// The join link, only if it is a well-formed https URL.
    public var meetingURL: URL? {
        guard let raw = meetingUrl, let url = URL(string: raw), url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else {
            return nil
        }
        return url
    }

    public func hasEnded(at now: Date) -> Bool { endsAt <= now }

    public var label: String {
        if cancelled { return "Cancelled" }
        if let number, of > 1 { return "Session \(number) of \(of)" }
        return "Class"
    }
}

public struct Booking: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let status: BookingStatus
    public let title: String
    public let topic: String
    public let firstName: String
    public let groupCancelled: Bool
    public let cancelReason: String?
    public let sessions: [ClassSession]
    public let canRequestCancellation: Bool
    public let cancelRequestedAt: Date?
    public let bookingPageUrl: String
    public let updatedAt: Date

    public init(id: String, status: BookingStatus, title: String, topic: String, firstName: String, groupCancelled: Bool, cancelReason: String?, sessions: [ClassSession], canRequestCancellation: Bool, cancelRequestedAt: Date?, bookingPageUrl: String, updatedAt: Date) {
        self.id = id
        self.status = status
        self.title = title
        self.topic = topic
        self.firstName = firstName
        self.groupCancelled = groupCancelled
        self.cancelReason = cancelReason
        self.sessions = sessions
        self.canRequestCancellation = canRequestCancellation
        self.cancelRequestedAt = cancelRequestedAt
        self.bookingPageUrl = bookingPageUrl
        self.updatedAt = updatedAt
    }

    public var activeSessions: [ClassSession] { sessions.filter { !$0.cancelled } }

    /// The next session that hasn't finished yet.
    public func nextSession(after now: Date) -> ClassSession? {
        activeSessions.filter { $0.endsAt > now }.min { $0.startsAt < $1.startsAt }
    }

    /// Shown under "Upcoming": a live booking with at least one session still to come.
    public func isUpcoming(at now: Date) -> Bool {
        [.confirmed, .pending, .review].contains(status) && !groupCancelled && nextSession(after: now) != nil
    }

    public var lastSessionStart: Date? { sessions.map(\.startsAt).max() }
}

public struct AppConfig: Codable, Hashable, Sendable {
    public let apiVersion: Int
    public let sellerName: String?
    public let supportEmail: String?
    public let supportUrl: String
    public let privacyUrl: String
    public let termsUrl: String
    public let cancellationSummary: String
}

public enum JSONCoding {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
