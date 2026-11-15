import KingstonTutoringCore
import SwiftUI
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var confirmingRemoveAll = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Class reminders", isOn: $model.reminders.enabled)
                    if model.reminders.enabled {
                        Picker("When", selection: $model.reminders.leadMinutes) {
                            ForEach(ReminderPreferences.choices.indices, id: \.self) { index in
                                let choice = ReminderPreferences.choices[index]
                                Text(choice.label).tag(choice.minutes)
                            }
                        }
                        if model.notificationsDenied {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Notifications are switched off for this app, so reminders can't be shown.")
                                    .font(.callout)
                                Button("Turn on notifications") {
                                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                                }
                            }
                        }
                    }
                } header: {
                    Text("Reminders")
                } footer: {
                    Text("Reminders are scheduled on this iPhone for confirmed classes and update when a date changes.")
                }

                Section("Help") {
                    if let email = model.supportEmailURL {
                        Link("Email support", destination: email)
                    }
                    Link("Support", destination: model.supportURL)
                    Link("Privacy notice", destination: model.privacyURL)
                    Link("Booking terms", destination: model.termsURL)
                }

                Section {
                    Button("Remove all bookings from this iPhone", role: .destructive) {
                        confirmingRemoveAll = true
                    }
                    .disabled(model.bookings.isEmpty)
                    if let deletion = model.dataDeletionURL {
                        Link("Ask for your data to be deleted", destination: deletion)
                    }
                } header: {
                    Text("Your data")
                } footer: {
                    Text("The app keeps a private key for each booking in the iPhone Keychain and a copy of your class details for offline use. There is no tracking or advertising.")
                }

                Section {
                    LabeledContent("Version", value: model.versionText)
                } footer: {
                    Text("Independent peer tutoring. Not run by or affiliated with Kingston University.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Remove all bookings from this iPhone?", isPresented: $confirmingRemoveAll, titleVisibility: .visible) {
                Button("Remove all", role: .destructive) {
                    Task { await model.removeAll() }
                }
            } message: {
                Text("Your bookings stay valid. You can add them again with your private links.")
            }
        }
    }
}
