import SwiftUI
import UIKit
import UserNotifications

@main
struct KingstonTutoringApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appDelegate.model)
                .onOpenURL { url in
                    // Private booking links (https://<site>/b/<token>) open the app when it's installed.
                    Task { await appDelegate.model.open(url: url) }
                }
        }
    }
}

/// Owns the model so a tapped reminder can open its booking even on a cold launch.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private(set) lazy var model = AppModel()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Show reminders as banners even while the app is open.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    /// Tapping a reminder opens that booking.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let bookingId = response.notification.request.content.userInfo["bookingId"] as? String
        Task { @MainActor in
            if let bookingId { self.model.show(bookingId: bookingId) }
            completionHandler()
        }
    }
}
