import DeviceActivity
import FamilyControls
import SwiftUI

extension DeviceActivityReport.Context {
    static let routine = Self("Routine Screen Time")
}

struct ScreenTimeMetrics {
    var total: TimeInterval
    var social: TimeInterval
    var apps: [(name: String, duration: TimeInterval)]
    var notifications: Int?
}

@main
struct ScreenTimeReport: DeviceActivityReportExtension {
    var body: some DeviceActivityReportScene {
        ScreenTimeScene { metrics in
            ScreenTimeReportView(metrics: metrics)
        }
    }
}

struct ScreenTimeScene: DeviceActivityReportScene {
    let context: DeviceActivityReport.Context = .routine
    let content: (ScreenTimeMetrics) -> ScreenTimeReportView

    func makeConfiguration(representing data: DeviceActivityResults<DeviceActivityData>) async -> ScreenTimeMetrics {
        var total: TimeInterval = 0
        var social: TimeInterval = 0
        var apps: [String: TimeInterval] = [:]
        var notifications: Int?

        for await deviceData in data {
            for await segment in deviceData.activitySegments {
                total += segment.totalActivityDuration
                for await category in segment.categories {
                    let label = category.category.localizedDisplayName ?? ""
                    if label.localizedCaseInsensitiveContains("social") {
                        social += category.totalActivityDuration
                    }
                    for await app in category.applications {
                        let name = app.application.localizedDisplayName ?? "App"
                        apps[name, default: 0] += app.totalActivityDuration
                        notifications = (notifications ?? 0) + app.numberOfNotifications
                    }
                }
            }
        }

        let ranked = apps
            .map { (name: $0.key, duration: $0.value) }
            .sorted { $0.duration > $1.duration }
            .prefix(8)
        return ScreenTimeMetrics(
            total: total,
            social: social,
            apps: Array(ranked),
            notifications: notifications
        )
    }
}

struct ScreenTimeReportView: View {
    let metrics: ScreenTimeMetrics

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                metricCard(title: "Total screen time", value: format(metrics.total))
                metricCard(title: "Social media", value: format(metrics.social))
                if let count = metrics.notifications {
                    metricCard(title: "Notifications", value: "\(count)")
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Top apps")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if metrics.apps.isEmpty {
                        Text("No app time in this range yet.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(metrics.apps.enumerated()), id: \.offset) { _, row in
                            HStack {
                                Text(row.name)
                                Spacer()
                                Text(format(row.duration))
                                    .foregroundStyle(.secondary)
                            }
                            .font(.subheadline)
                        }
                    }
                }
                .padding(14)
                .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .padding(4)
        }
    }

    func metricCard(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .tracking(0.8)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    func format(_ interval: TimeInterval) -> String {
        let minutes = Int((interval / 60).rounded())
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 { return "\(rest)m" }
        return "\(hours)h \(rest)m"
    }
}
