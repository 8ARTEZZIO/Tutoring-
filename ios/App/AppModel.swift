import Foundation
import KingstonTutoringCore
import SwiftUI

/// App state for the views. All booking logic lives in KingstonTutoringCore (unit-tested); this class only
/// connects it to SwiftUI, the Keychain, notifications and settings.
@MainActor
final class AppModel: ObservableObject {
    struct Notice: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    @Published private(set) var bookings: [Booking] = []
    @Published private(set) var isRefreshing = false
    /// Why the latest details couldn't be fetched (shown as a banner over the saved copy), or nil.
    @Published private(set) var syncProblem: String?
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var config: AppConfig?
    @Published private(set) var notificationsDenied = false
    @Published var notice: Notice?
    @Published var path: [String] = []
    @Published var showingAdd = false
    @Published var showingSettings = false
    @Published var reminders: ReminderPreferences {
        didSet {
            guard reminders != oldValue else { return }
            if let data = try? JSONEncoder().encode(reminders) { defaults.set(data, forKey: Keys.reminders) }
            let askPermission = reminders.enabled && !oldValue.enabled
            Task { await syncReminders(requestPermission: askPermission) }
        }
    }

    let publicOrigin: URL
    private let api: APIClient
    private let library: BookingLibrary
    private let scheduler = NotificationScheduler()
    private let defaults = UserDefaults.standard

    private enum Keys {
        static let reminders = "reminderPreferences"
        static let lastUpdated = "lastUpdated"
        static let hasLaunched = "hasLaunchedBefore"
    }

    /// The link offered by "Use the demo link" (Debug demo mode only; always nil in release builds).
    let demoLink: String?

    init() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1"
        let backend = Self.makeBackend()
        publicOrigin = backend.origin
        demoLink = backend.demoLink
        api = APIClient(baseURL: backend.origin, transport: backend.transport, userAgent: "KingstonTutoring-iOS/\(version)")
        library = BookingLibrary(api: api, tokens: backend.tokens, cache: backend.cache)

        if let data = UserDefaults.standard.data(forKey: Keys.reminders), let saved = try? JSONDecoder().decode(ReminderPreferences.self, from: data) {
            reminders = saved
        } else {
            reminders = .default
        }
        lastUpdated = backend.demoLink == nil ? UserDefaults.standard.object(forKey: Keys.lastUpdated) as? Date : nil
        bookings = library.bookings
    }

    private struct Backend {
        let origin: URL
        let transport: HTTPTransport
        let tokens: TokenStore
        let cache: BookingCache
        let demoLink: String?
    }

    private static func makeBackend() -> Backend {
        #if DEBUG
        // Debug builds only: launch with -KTDemo (ticked in the scheme's Run arguments) for fictional data
        // that needs no server. Used for screenshots and for trying the app before the site is deployed.
        if ProcessInfo.processInfo.arguments.contains("-KTDemo") {
            let demo = DemoTransport()
            return Backend(origin: DemoTransport.origin, transport: demo, tokens: InMemoryTokenStore(demo.preloadedTokens), cache: InMemoryBookingCache(), demoLink: DemoTransport.addableLink)
        }
        #endif
        let configured = Bundle.main.object(forInfoDictionaryKey: "KTPublicOrigin") as? String
        let origin = configured.flatMap(URL.init(string:)) ?? URL(string: "https://localhost")!

        // Keychain items survive deleting the app; start clean after a reinstall.
        let tokenStore = KeychainTokenStore()
        if !UserDefaults.standard.bool(forKey: Keys.hasLaunched) {
            tokenStore.reset()
            UserDefaults.standard.set(true, forKey: Keys.hasLaunched)
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return Backend(origin: origin, transport: URLSessionTransport(), tokens: tokenStore, cache: FileBookingCache(url: support.appendingPathComponent("bookings.json")), demoLink: nil)
    }

    // MARK: Bookings

    func booking(id: String) -> Booking? { bookings.first { $0.id == id } }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let outcome = try await library.refresh()
            syncProblem = nil
            lastUpdated = Date()
            if demoLink == nil { defaults.set(lastUpdated, forKey: Keys.lastUpdated) }
            bookings = library.bookings
            #if DEBUG
            openDemoScreenOnce()
            #endif
            if !outcome.removedTitles.isEmpty {
                let several = outcome.removedTitles.count > 1
                notice = Notice(
                    title: several ? "Bookings removed" : "Booking removed",
                    message: "\(outcome.removedTitles.joined(separator: ", ")) \(several ? "are" : "is") no longer available on this iPhone because the private link was replaced or switched off. Ask for a new link if you still need it."
                )
            }
        } catch let error as APIError {
            syncProblem = error == .offline ? "You're offline." : "Couldn't update just now."
        } catch {
            syncProblem = "Couldn't update just now."
        }
        if let latest = try? await api.config() { config = latest }
        await syncReminders(requestPermission: false)
    }

    /// Returns an error message to show, or nil on success.
    func add(link: String) async -> String? {
        do {
            let booking = try await library.add(link: link)
            bookings = library.bookings
            showingAdd = false
            showingSettings = false
            path = [booking.id]
            await syncReminders(requestPermission: false)
            return nil
        } catch let error as APIError {
            return error.userMessage
        } catch {
            return APIError.offline.userMessage
        }
    }

    func open(url: URL) async {
        guard let token = LinkParser.token(fromUniversalLink: url, expectedHost: publicOrigin.host) else { return }
        if let message = await add(link: token) {
            notice = Notice(title: "Couldn't add booking", message: message)
        }
    }

    func show(bookingId: String) {
        guard booking(id: bookingId) != nil else { return }
        showingAdd = false
        showingSettings = false
        path = [bookingId]
    }

    func remove(_ booking: Booking) async {
        await library.remove(bookingId: booking.id)
        bookings = library.bookings
        path.removeAll { $0 == booking.id }
        await syncReminders(requestPermission: false)
    }

    func removeAll() async {
        await library.removeAll()
        bookings = []
        path = []
        await syncReminders(requestPermission: false)
    }

    /// Returns an error message to show, or nil on success.
    func requestCancellation(_ booking: Booking, note: String) async -> String? {
        do {
            _ = try await library.requestCancellation(bookingId: booking.id, note: note)
            bookings = library.bookings
            return nil
        } catch let error as APIError {
            return error.userMessage
        } catch {
            return APIError.offline.userMessage
        }
    }

    #if DEBUG
    private var demoScreenOpened = false

    /// Demo mode only: `-KTDemoScreen detail|settings` opens that screen, so ./setup.sh screenshots can
    /// capture each one.
    private func openDemoScreenOnce() {
        guard demoLink != nil, !demoScreenOpened else { return }
        demoScreenOpened = true
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-KTDemoScreen"), index + 1 < arguments.count else { return }
        switch arguments[index + 1] {
        case "detail": path = ["bk_demo_group"]
        case "settings": showingSettings = true
        default: break
        }
    }
    #endif

    // MARK: Reminders

    func syncReminders(requestPermission: Bool) async {
        if reminders.enabled {
            var allowed = await scheduler.isAuthorized()
            if !allowed && requestPermission { allowed = await scheduler.requestAuthorization() }
            notificationsDenied = !allowed
            guard allowed else {
                await scheduler.apply([])
                return
            }
        } else {
            notificationsDenied = false
        }
        let plan = ReminderPlanner.plan(for: bookings, preferences: reminders, now: Date(), deviceZone: .current)
        await scheduler.apply(plan)
    }

    // MARK: Links

    var supportURL: URL { config.flatMap { URL(string: $0.supportUrl) } ?? publicOrigin.appendingPathComponent("support") }
    var privacyURL: URL { config.flatMap { URL(string: $0.privacyUrl) } ?? publicOrigin.appendingPathComponent("privacy") }
    var termsURL: URL { config.flatMap { URL(string: $0.termsUrl) } ?? publicOrigin.appendingPathComponent("terms") }

    var supportEmailURL: URL? {
        guard let email = config?.supportEmail, !email.isEmpty else { return nil }
        return URL(string: "mailto:\(email)")
    }

    var dataDeletionURL: URL? {
        guard let email = config?.supportEmail, !email.isEmpty else { return nil }
        let subject = "Please delete my data".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return URL(string: "mailto:\(email)?subject=\(subject)")
    }

    var versionText: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(version) (\(build))"
    }
}
