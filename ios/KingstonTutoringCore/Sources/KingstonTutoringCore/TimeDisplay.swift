import Foundation

/// Classes are scheduled in UK time. When the phone is set to a different time zone, the app also shows
/// the student's own time.
public enum TimeDisplay {
    public static let uk = TimeZone(identifier: "Europe/London")!

    public static func isUKTime(_ zone: TimeZone, at date: Date) -> Bool {
        zone.secondsFromGMT(for: date) == uk.secondsFromGMT(for: date)
    }

    /// "Your time: Tue 24 Nov, 19:00–20:00", or nil when the phone's clock already matches UK time.
    public static func localText(start: Date, end: Date, in zone: TimeZone) -> String? {
        if isUKTime(zone, at: start) && isUKTime(zone, at: end) { return nil }
        let day = formatter("EEE d MMM", zone)
        let time = formatter("HH:mm", zone)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let endText = calendar.isDate(start, inSameDayAs: end)
            ? time.string(from: end)
            : "\(day.string(from: end)), \(time.string(from: end))"
        return "Your time: \(day.string(from: start)), \(time.string(from: start))–\(endText)"
    }

    /// "in 15 minutes", "in 1 hour", "tomorrow", "in 2 days"…
    public static func relativeLead(minutes: Int) -> String {
        if minutes < 60 { return "in \(minutes) minute\(minutes == 1 ? "" : "s")" }
        if minutes == 1440 { return "tomorrow" }
        if minutes % 1440 == 0 { return "in \(minutes / 1440) days" }
        if minutes % 60 == 0 {
            let hours = minutes / 60
            return "in \(hours) hour\(hours == 1 ? "" : "s")"
        }
        return "in \(minutes / 60) h \(minutes % 60) min"
    }

    static func formatter(_ format: String, _ zone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = format
        return formatter
    }
}
