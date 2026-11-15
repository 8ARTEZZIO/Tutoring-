import SwiftUI

struct AddBookingView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var working = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Use the private link from your booking confirmation email. Opening that link on this iPhone also adds your booking automatically.")
                        .font(.callout)
                }
                Section("Your private link") {
                    PasteButton(payloadType: String.self) { strings in
                        guard let first = strings.first else { return }
                        Task { @MainActor in
                            text = first
                            await submit(first)
                        }
                    }
                    TextField("Paste the link here", text: $text, axis: .vertical)
                        .lineLimit(1...4)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Add booking") {
                        Task { await submit(text) }
                    }
                    .disabled(working || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let demoLink = model.demoLink {
                        Button("Use the demo link") {
                            text = demoLink
                            Task { await submit(demoLink) }
                        }
                        .disabled(working)
                    }
                }
                if working {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Adding your booking…")
                        }
                    }
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
                Section {
                    Text("Lost your link? Contact support from Settings and you'll be sent a new one.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Add booking")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func submit(_ value: String) async {
        guard !working else { return }
        working = true
        errorMessage = nil
        errorMessage = await model.add(link: value)
        working = false
    }
}
