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
                }
                for await app in segment.applications {
                    let name = app.application.localizedDisplayName ?? "App"
                    apps[name, default: 0] += app.totalActivityDuration
                    if let extra = notificationCount(from: app) {
                        notifications = (notifications ?? 0) + extra
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

/// Apple does not document a notification-count field on DeviceActivity.
/// Only surface a number when the result object actually carries one.
func notificationCount(from value: Any) -> Int? {
    let mirror = Mirror(reflecting: value)
    for child in mirror.children {
        guard let label = child.label?.lowercased() else { continue }
        guard label.contains("notif") else { continue }
        if let number = child.value as? Int { return number }
        if let number = child.value as? Int64 { return Int(number) }
    }
    return nil
}

struct ScreenTimeReportView: View {
    let metrics: ScreenTimeMetrics

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                metricCard(title: "Screen time", value: format(metrics.total))
                metricCard(title: "Social", value: format(metrics.social))
            }
            if let count = metrics.notifications {
                metricCard(title: "Notifications", value: "\(count)")
            }
            VStack(alignment: .leading, spacing: 10) {
                Text("Top apps")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(red: 0.55, green: 0.22, blue: 0.35))
                if metrics.apps.isEmpty {
                    Text("No app time in this range yet.")
                        .font(.subheadline)
                        .foregroundStyle(Color(red: 0.35, green: 0.28, blue: 0.32))
                } else {
                    ForEach(Array(metrics.apps.prefix(6).enumerated()), id: \.offset) { _, row in
                        HStack(alignment: .firstTextBaseline) {
                            Text(row.name)
                                .foregroundStyle(Color(red: 0.18, green: 0.12, blue: 0.16))
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            Text(format(row.duration))
                                .foregroundStyle(Color(red: 0.45, green: 0.22, blue: 0.32))
                                .fontWeight(.semibold)
                        }
                        .font(.subheadline)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    func metricCard(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(red: 0.55, green: 0.22, blue: 0.35))
            Text(value)
                .font(.title.weight(.bold))
                .foregroundStyle(Color(red: 0.18, green: 0.12, blue: 0.16))
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    func format(_ interval: TimeInterval) -> String {
        let minutes = Int((interval / 60).rounded())
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 { return "\(rest)m" }
        if rest == 0 { return "\(hours)h" }
        return "\(hours)h \(rest)m"
    }
}
