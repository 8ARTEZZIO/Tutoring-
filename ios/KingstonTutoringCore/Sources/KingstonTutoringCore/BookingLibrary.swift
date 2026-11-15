import Foundation

public struct RefreshOutcome: Equatable, Sendable {
    /// Bookings that disappeared because their access was revoked (or the link replaced).
    public let removedTitles: [String]
}

/// The bookings on this phone: add, refresh, remove and request cancellation, with offline persistence.
/// Network failures never drop saved data; only an explicit "revoked" answer from the server removes a booking.
@MainActor
public final class BookingLibrary {
    private struct Entry: Equatable {
        var bookingId: String
        var token: String
        var addedAt: Date
        var booking: Booking?
        /// Bumped on every change made on this phone, so a refresh that started earlier never overwrites it.
        var revision = 0
    }

    private var entries: [Entry]
    private var revisionCounter = 0
    public private(set) var lastRefreshed: Date?
    private let api: APIClient
    private let tokens: TokenStore
    private let cache: BookingCache
    private let now: () -> Date

    public init(api: APIClient, tokens: TokenStore, cache: BookingCache, now: @escaping () -> Date = Date.init) {
        self.api = api
        self.tokens = tokens
        self.cache = cache
        self.now = now
        let cached = Dictionary(cache.load().map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        entries = tokens.load().compactMap { stored in
            guard seen.insert(stored.bookingId).inserted else { return nil }
            return Entry(bookingId: stored.bookingId, token: stored.token, addedAt: stored.addedAt, booking: cached[stored.bookingId])
        }
    }

    /// Bookings with details, in the order they were added.
    public var bookings: [Booking] { entries.compactMap(\.booking) }

    public var isEmpty: Bool { entries.isEmpty }

    public func booking(id: String) -> Booking? { entries.first { $0.bookingId == id }?.booking }

    /// Add from pasted text or an opened link. Adding the same booking again keeps one copy with the new key.
    @discardableResult
    public func add(link: String) async throws -> Booking {
        guard LinkParser.token(in: link) != nil else { throw APIError.notALink }
        let (token, booking) = try await api.addBooking(link: link)
        if let index = entries.firstIndex(where: { $0.bookingId == booking.id }) {
            let oldToken = entries[index].token
            entries[index].token = token
            entries[index].booking = booking
            entries[index].revision = nextRevision()
            try persist()
            if oldToken != token { try? await api.forget(token: oldToken) }
        } else {
            entries.append(Entry(bookingId: booking.id, token: token, addedAt: now(), booking: booking, revision: nextRevision()))
            try persist()
        }
        return booking
    }

    /// Fetch the latest state. Throws (keeping everything) when offline or the reply is unusable.
    @discardableResult
    public func refresh() async throws -> RefreshOutcome {
        guard !entries.isEmpty else {
            lastRefreshed = now()
            return RefreshOutcome(removedTitles: [])
        }
        let snapshot = entries
        let results = try await api.refresh(tokens: snapshot.map(\.token))
        guard results.count == snapshot.count else { throw APIError.invalidResponse }
        var answers: [String: (revision: Int, result: RefreshResult)] = [:]
        for (entry, result) in zip(snapshot, results) { answers[entry.token] = (entry.revision, result) }
        var updated: [Entry] = []
        var removed: [String] = []
        var seen = Set<String>()
        // Walk the current entries, not the snapshot: anything removed while the request was in flight stays
        // removed, and anything added, re-keyed or updated in the meantime keeps its newer local state.
        for entry in entries {
            guard let answer = answers[entry.token], answer.revision == entry.revision else {
                if seen.insert(entry.bookingId).inserted { updated.append(entry) }
                continue
            }
            switch answer.result {
            case .booking(let booking):
                guard seen.insert(entry.bookingId).inserted else { continue }
                var fresh = entry
                fresh.booking = booking
                updated.append(fresh)
            case .revoked, .invalid:
                if let title = entry.booking?.title { removed.append(title) }
            }
        }
        entries = updated
        lastRefreshed = now()
        try persist()
        return RefreshOutcome(removedTitles: removed)
    }

    /// Remove from this phone. Switching the key off on the server is best-effort (works offline too).
    public func remove(bookingId: String) async {
        guard let index = entries.firstIndex(where: { $0.bookingId == bookingId }) else { return }
        let entry = entries.remove(at: index)
        try? persist()
        try? await api.forget(token: entry.token)
    }

    public func removeAll() async {
        for id in entries.map(\.bookingId) { await remove(bookingId: id) }
    }

    public func requestCancellation(bookingId: String, note: String) async throws -> Booking {
        guard let index = entries.firstIndex(where: { $0.bookingId == bookingId }) else { throw APIError.notFound }
        let booking = try await api.requestCancellation(token: entries[index].token, note: note)
        if let current = entries.firstIndex(where: { $0.bookingId == bookingId }) {
            entries[current].booking = booking
            entries[current].revision = nextRevision()
            try persist()
        }
        return booking
    }

    private func nextRevision() -> Int {
        revisionCounter += 1
        return revisionCounter
    }

    private func persist() throws {
        try tokens.save(entries.map { StoredToken(bookingId: $0.bookingId, token: $0.token, addedAt: $0.addedAt) })
        try cache.save(entries.compactMap(\.booking))
    }
}

/// Upcoming bookings first (soonest next session first), then finished, cancelled or unpaid ones (latest first).
public func bookingSections(_ bookings: [Booking], now: Date) -> (upcoming: [Booking], past: [Booking]) {
    let upcoming = bookings.filter { $0.isUpcoming(at: now) }.sorted {
        let a = $0.nextSession(after: now)!.startsAt
        let b = $1.nextSession(after: now)!.startsAt
        return a == b ? $0.id < $1.id : a < b
    }
    let past = bookings.filter { !$0.isUpcoming(at: now) }.sorted {
        let a = $0.lastSessionStart ?? .distantPast
        let b = $1.lastSessionStart ?? .distantPast
        return a == b ? $0.id < $1.id : a > b
    }
    return (upcoming, past)
}
