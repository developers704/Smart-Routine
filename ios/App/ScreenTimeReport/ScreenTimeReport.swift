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
            .prefix(4)
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

    private let ink = Color(red: 0.173, green: 0.122, blue: 0.157)
    private let muted = Color(red: 0.553, green: 0.451, blue: 0.502)
    private let paper = Color(red: 1.0, green: 0.969, blue: 0.980)
    private let fill = Color(red: 1.0, green: 0.925, blue: 0.945)
    private let line = Color(red: 0.769, green: 0.357, blue: 0.471).opacity(0.28)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                metricCard(title: "Total", value: format(metrics.total))
                metricCard(title: "Social", value: format(metrics.social))
                metricCard(title: "Alerts", value: metrics.notifications.map(String.init) ?? "0")
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Top apps")
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(muted)
                if metrics.apps.isEmpty {
                    Text("No app time in this range yet.")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(ink)
                } else {
                    ForEach(Array(metrics.apps.enumerated()), id: \.offset) { _, row in
                        HStack {
                            Text(row.name)
                                .foregroundStyle(ink)
                            Spacer()
                            Text(format(row.duration))
                                .foregroundStyle(muted)
                        }
                        .font(.subheadline.weight(.semibold))
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(line, lineWidth: 1)
            )
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(paper)
    }

    func metricCard(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(muted)
            Text(value)
                .font(.title3.weight(.semibold))
                .foregroundStyle(ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(line, lineWidth: 1)
        )
    }

    func format(_ interval: TimeInterval) -> String {
        let minutes = Int((interval / 60).rounded())
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 { return "\(rest)m" }
        return "\(hours)h \(rest)m"
    }
}
