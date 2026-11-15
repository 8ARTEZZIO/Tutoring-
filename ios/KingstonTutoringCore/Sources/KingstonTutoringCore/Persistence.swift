import Foundation

/// One booking added on this phone: its device access token (kept in the Keychain by the app).
public struct StoredToken: Codable, Equatable, Sendable {
    public let bookingId: String
    public let token: String
    public let addedAt: Date

    public init(bookingId: String, token: String, addedAt: Date) {
        self.bookingId = bookingId
        self.token = token
        self.addedAt = addedAt
    }
}

public protocol TokenStore: AnyObject {
    func load() -> [StoredToken]
    func save(_ tokens: [StoredToken]) throws
}

/// Offline copy of booking details (no secrets in it).
public protocol BookingCache: AnyObject {
    func load() -> [Booking]
    func save(_ bookings: [Booking]) throws
}

public final class InMemoryTokenStore: TokenStore {
    public var tokens: [StoredToken]
    public init(_ tokens: [StoredToken] = []) { self.tokens = tokens }
    public func load() -> [StoredToken] { tokens }
    public func save(_ tokens: [StoredToken]) throws { self.tokens = tokens }
}

public final class InMemoryBookingCache: BookingCache {
    public var bookings: [Booking]
    public init(_ bookings: [Booking] = []) { self.bookings = bookings }
    public func load() -> [Booking] { bookings }
    public func save(_ bookings: [Booking]) throws { self.bookings = bookings }
}

/// JSON file cache. A missing or unreadable file is treated as empty (and removed), never as a crash.
public final class FileBookingCache: BookingCache {
    private struct CacheFile: Codable {
        let version: Int
        let bookings: [Booking]
    }

    public let url: URL

    public init(url: URL) { self.url = url }

    public func load() -> [Booking] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        do {
            return try JSONCoding.decoder().decode(CacheFile.self, from: data).bookings
        } catch {
            try? FileManager.default.removeItem(at: url)
            return []
        }
    }

    public func save(_ bookings: [Booking]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONCoding.encoder().encode(CacheFile(version: 1, bookings: bookings))
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        // The access keys are never backed up (Keychain, this device only), so the details aren't either.
        var file = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? file.setResourceValues(values)
        #else
        try data.write(to: url, options: [.atomic])
        #endif
    }
}
