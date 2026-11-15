import EventKit
import EventKitUI
import KingstonTutoringCore
import SwiftUI

/// Apple's "add event" sheet, pre-filled. On iOS 17+ this needs no calendar permission: the system shows
/// the sheet and the student decides whether to save it.
struct CalendarEventView: UIViewControllerRepresentable {
    let title: String
    let session: ClassSession
    let onDone: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = session.startsAt
        event.endDate = session.endsAt
        event.timeZone = TimeZone(identifier: "Europe/London")
        if let url = session.meetingURL {
            event.url = url
            event.location = url.absoluteString
            event.notes = "Join link: \(url.absoluteString)\nThe Kingston Tutoring app always shows the latest time and link."
        } else {
            event.location = "Online"
        }
        let controller = EKEventEditViewController()
        controller.eventStore = store
        controller.event = event
        controller.editViewDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: EKEventEditViewController, context: Context) {}

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let onDone: () -> Void

        init(onDone: @escaping () -> Void) { self.onDone = onDone }

        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            onDone()
        }
    }
}
