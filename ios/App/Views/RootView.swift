import KingstonTutoringCore
import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack(path: $model.path) {
            BookingsListView()
                .navigationTitle("My classes")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            model.showingSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("Settings")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            model.showingAdd = true
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("Add booking")
                    }
                }
                .navigationDestination(for: String.self) { id in
                    BookingDetailView(bookingId: id)
                }
        }
        .sheet(isPresented: $model.showingAdd) {
            AddBookingView()
        }
        .sheet(isPresented: $model.showingSettings) {
            SettingsView()
        }
        .alert(
            model.notice?.title ?? "",
            isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } }),
            presenting: model.notice
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { notice in
            Text(notice.message)
        }
        .task {
            await model.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await model.refresh() }
            }
        }
    }
}

struct BookingsListView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let sections = bookingSections(model.bookings, now: Date())
        Group {
            if model.bookings.isEmpty {
                ContentUnavailableView {
                    Label("No classes yet", systemImage: "calendar.badge.plus")
                } description: {
                    Text("Open the private booking link from your confirmation email on this iPhone, or copy it and add it here.")
                } actions: {
                    Button("Add booking") { model.showingAdd = true }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                List {
                    if let problem = model.syncProblem {
                        Section {
                            SyncBanner(problem: problem, lastUpdated: model.lastUpdated)
                        }
                    }
                    if !sections.upcoming.isEmpty {
                        Section("Upcoming") {
                            ForEach(sections.upcoming) { booking in
                                NavigationLink(value: booking.id) { BookingRow(booking: booking) }
                            }
                        }
                    }
                    if !sections.past.isEmpty {
                        Section("Past and cancelled") {
                            ForEach(sections.past) { booking in
                                NavigationLink(value: booking.id) { BookingRow(booking: booking) }
                            }
                        }
                    }
                }
                .refreshable {
                    await model.refresh()
                }
            }
        }
    }
}

struct BookingRow: View {
    let booking: Booking

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(booking.title)
                    .font(.headline)
                Spacer(minLength: 8)
                StatusBadge(status: booking.status)
            }
            if let next = booking.nextSession(after: Date()) {
                Text("\(next.ukDate) · \(next.ukTime)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let local = TimeDisplay.localText(start: next.startsAt, end: next.endsAt, in: .current) {
                    Text(local)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text(booking.groupCancelled ? "This group was cancelled" : "No upcoming sessions")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

struct SyncBanner: View {
    let problem: String
    let lastUpdated: Date?

    var body: some View {
        Label {
            if let lastUpdated {
                Text("\(problem) Showing details saved \(lastUpdated.formatted(.relative(presentation: .named))). Pull down to try again.")
            } else {
                Text("\(problem) Showing saved details. Pull down to try again.")
            }
        } icon: {
            Image(systemName: "wifi.slash")
        }
        .font(.footnote)
    }
}
