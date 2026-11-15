import KingstonTutoringCore
import SwiftUI

struct BookingDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    let bookingId: String

    @State private var calendarSession: ClassSession?
    @State private var showingCancellation = false
    @State private var confirmingRemoval = false

    var body: some View {
        if let booking = model.booking(id: bookingId) {
            List {
                Section {
                    header(booking)
                }
                Section(Self.datesTitle(booking)) {
                    ForEach(booking.sessions) { session in
                        SessionRow(
                            session: session,
                            canAddToCalendar: booking.status == .confirmed,
                            onJoin: { url in openURL(url) },
                            onAddToCalendar: { calendarSession = session }
                        )
                    }
                }
                if booking.canRequestCancellation || booking.cancelRequestedAt != nil {
                    Section("Cancellation") {
                        if let requested = booking.cancelRequestedAt {
                            Text("You asked to cancel on \(requested.formatted(date: .abbreviated, time: .omitted)). You'll get a reply by email.")
                                .font(.callout)
                        } else {
                            Button("Request cancellation") { showingCancellation = true }
                        }
                    }
                }
                Section {
                    Button("Remove from this iPhone", role: .destructive) { confirmingRemoval = true }
                } footer: {
                    Text("This doesn't cancel your booking. You can add it again with your private link.")
                }
            }
            .navigationTitle("Booking")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                await model.refresh()
            }
            .sheet(item: $calendarSession) { session in
                CalendarEventView(title: booking.title, session: session) { calendarSession = nil }
                    .ignoresSafeArea()
            }
            .sheet(isPresented: $showingCancellation) {
                CancellationRequestView(booking: booking)
            }
            .confirmationDialog("Remove this booking from this iPhone?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    Task { await model.remove(booking) }
                }
            } message: {
                Text("Your booking stays valid. Its reminders are removed from this iPhone.")
            }
        } else {
            ContentUnavailableView("Booking not found", systemImage: "questionmark.circle", description: Text("It may have been removed from this iPhone."))
        }
    }

    @ViewBuilder
    private func header(_ booking: Booking) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(booking.topic.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(booking.title)
                .font(.title2.bold())
            HStack {
                StatusBadge(status: booking.status)
                Text("Booked for \(booking.firstName)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if booking.groupCancelled {
                Text(Self.groupCancelledText(reason: booking.cancelReason))
                    .font(.callout)
            } else if let explanation = booking.status.explanation {
                Text(explanation)
                    .font(.callout)
            }
        }
        .padding(.vertical, 4)
    }

    static func datesTitle(_ booking: Booking) -> String {
        let count = booking.activeSessions.count
        return count > 1 ? "Your \(count) dates (UK time)" : "Your class (UK time)"
    }

    static func groupCancelledText(reason: String?) -> String {
        var parts = ["This group has been cancelled."]
        if let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty { parts.append(reason) }
        parts.append("You'll get a full refund for sessions that haven't taken place.")
        return parts.joined(separator: " ")
    }
}

struct SessionRow: View {
    let session: ClassSession
    let canAddToCalendar: Bool
    let onJoin: (URL) -> Void
    let onAddToCalendar: () -> Void

    var body: some View {
        let now = Date()
        let upcoming = !session.cancelled && !session.hasEnded(at: now)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(session.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(session.cancelled ? Color.red : Color.secondary)
                Spacer()
                if !session.cancelled && session.hasEnded(at: now) {
                    Text("Finished")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Text(session.ukDate)
                .font(.headline)
                .strikethrough(session.cancelled)
            Text(session.ukTime)
                .font(.subheadline)
                .strikethrough(session.cancelled)
            if !session.cancelled, let local = TimeDisplay.localText(start: session.startsAt, end: session.endsAt, in: .current) {
                Text(local)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if upcoming && (session.meetingURL != nil || canAddToCalendar) {
                HStack(spacing: 12) {
                    if let url = session.meetingURL {
                        Button {
                            onJoin(url)
                        } label: {
                            Label("Join class", systemImage: "video.fill")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    if canAddToCalendar {
                        Button {
                            onAddToCalendar()
                        } label: {
                            Label("Add to Calendar", systemImage: "calendar.badge.plus")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
    }
}

struct CancellationRequestView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let booking: Booking

    @State private var note = ""
    @State private var sending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let summary = model.config?.cancellationSummary {
                    Section("How cancellation works") {
                        Text(summary).font(.callout)
                    }
                }
                Section("Anything to add? (optional)") {
                    TextField("Reason or question", text: $note, axis: .vertical)
                        .lineLimit(3...8)
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Request cancellation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        Task {
                            sending = true
                            errorMessage = await model.requestCancellation(booking, note: note)
                            sending = false
                            if errorMessage == nil { dismiss() }
                        }
                    }
                    .disabled(sending)
                }
            }
        }
    }
}
