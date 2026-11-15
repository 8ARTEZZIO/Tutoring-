import Foundation
import KingstonTutoringCore
import UserNotifications

/// Applies a reminder plan as local notifications (nothing is sent to a server).
@MainActor
final class NotificationScheduler {
    private let center = UNUserNotificationCenter.current()
    /// Updates run one after another, in the order they were asked for.
    private var queue: Task<Void, Never>?

    func isAuthorized() async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        default:
            return false
        }
    }

    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
    }

    /// Replaces all of this app's pending reminders with the plan (at most 60, the soonest first).
    func apply(_ plan: [PlannedReminder]) async {
        let previous = queue
        let next = Task { @MainActor in
            await previous?.value
            await self.replace(with: plan)
        }
        queue = next
        await next.value
    }

    private func replace(with plan: [PlannedReminder]) async {
        let pending = await center.pendingNotificationRequests()
        let ours = pending.map(\.identifier).filter { $0.hasPrefix(ReminderPlanner.identifierPrefix) }
        if !ours.isEmpty { center.removePendingNotificationRequests(withIdentifiers: ours) }
        for reminder in plan {
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.body
            content.sound = .default
            content.userInfo = ["bookingId": reminder.bookingId]
            let interval = max(1, reminder.fireDate.timeIntervalSinceNow)
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
            let request = UNNotificationRequest(identifier: reminder.identifier, content: content, trigger: trigger)
            try? await center.add(request)
        }
    }
}
