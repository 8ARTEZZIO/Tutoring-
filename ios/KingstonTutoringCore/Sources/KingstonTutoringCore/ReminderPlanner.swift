import Foundation

public struct ReminderPreferences: Codable, Equatable, Sendable {
    public var enabled: Bool
    /// Minutes before each session. Lead times are absolute durations, like Calendar alerts.
    public var leadMinutes: [Int]

    public init(enabled: Bool, leadMinutes: [Int]) {
        self.enabled = enabled
        self.leadMinutes = leadMinutes
    }

    public static let `default` = ReminderPreferences(enabled: false, leadMinutes: [60])

    public static let choices: [(label: String, minutes: [Int])] = [
        ("15 minutes before", [15]),
        ("1 hour before", [60]),
        ("1 day before", [1440]),
        ("1 day and 1 hour before", [1440, 60]),
    ]
}

public struct PlannedReminder: Equatable, Sendable {
    public let identifier: String
    public let fireDate: Date
    public let title: String
    public let body: String
    public let bookingId: String
}

/// Turns bookings into local notifications. Only confirmed bookings, sessions that are still on and in the
/// future, and fire times that haven't passed. iOS keeps at most 64 pending notifications per app, so only
/// the soonest `maximum` are returned; the app re-plans on every refresh.
public enum ReminderPlanner {
    public static let identifierPrefix = "kt.reminder."
    public static let maximum = 60

    public static func plan(for bookings: [Booking], preferences: ReminderPreferences, now: Date, deviceZone: TimeZone) -> [PlannedReminder] {
        guard preferences.enabled else { return [] }
        let leads = Array(Set(preferences.leadMinutes.filter { $0 > 0 && $0 <= 7 * 1440 })).sorted(by: >)
        var seenSessions = Set<String>()
        var planned: [PlannedReminder] = []
        for booking in bookings where booking.status == .confirmed && !booking.groupCancelled {
            for session in booking.sessions where !session.cancelled && session.startsAt > now {
                guard seenSessions.insert(session.uid).inserted else { continue }
                for lead in leads {
                    let fire = session.startsAt.addingTimeInterval(TimeInterval(-lead * 60))
                    guard fire > now.addingTimeInterval(5) else { continue }
                    var body = "Starts \(TimeDisplay.relativeLead(minutes: lead)): \(session.ukDate), \(session.ukTime)"
                    if let local = TimeDisplay.localText(start: session.startsAt, end: session.endsAt, in: deviceZone) {
                        body += "\n\(local)"
                    }
                    if session.of > 1, let number = session.number {
                        body = "Session \(number) of \(session.of). " + body
                    }
                    planned.append(PlannedReminder(
                        identifier: "\(identifierPrefix)\(session.uid)#\(session.sequence)#\(lead)",
                        fireDate: fire,
                        title: booking.title,
                        body: body,
                        bookingId: booking.id
                    ))
                }
            }
        }
        planned.sort { $0.fireDate == $1.fireDate ? $0.identifier < $1.identifier : $0.fireDate < $1.fireDate }
        return Array(planned.prefix(maximum))
    }
}
