import KingstonTutoringCore
import SwiftUI

struct StatusBadge: View {
    let status: BookingStatus

    var body: some View {
        Text(status.label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
            .accessibilityLabel("Status: \(status.label)")
    }

    private var color: Color {
        switch status {
        case .confirmed: return .green
        case .pending, .review: return .orange
        case .cancelled: return .red
        case .notBooked, .unknown: return .gray
        }
    }
}
