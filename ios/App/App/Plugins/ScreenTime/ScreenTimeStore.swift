import Foundation
#if canImport(FamilyControls)
import FamilyControls
#endif
#if canImport(DeviceActivity)
import DeviceActivity
#endif

/// Persists FamilyActivitySelection only in native storage (App Group, then
/// standard defaults). Tokens never leave the process — no JS, logs, or network.
enum ScreenTimeStore {
    static let appGroupId = "group.app.routine.calendar"
    static let selectionKey = "screenTime.familyActivitySelection"
    static let rangeKey = "screenTime.range"
    static let contextName = "Routine Screen Time"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroupId) ?? .standard
    }

    static func range() -> String {
        let value = defaults.string(forKey: rangeKey) ?? "today"
        return value == "week" ? "week" : "today"
    }

    static func setRange(_ value: String) {
        defaults.set(value == "week" ? "week" : "today", forKey: rangeKey)
    }

    #if canImport(FamilyControls)
    @available(iOS 26.0, *)
    static func loadSelection() -> FamilyActivitySelection {
        guard let data = defaults.data(forKey: selectionKey) else {
            return FamilyActivitySelection()
        }
        return (try? JSONDecoder().decode(FamilyActivitySelection.self, from: data)) ?? FamilyActivitySelection()
    }

    @available(iOS 26.0, *)
    static func saveSelection(_ selection: FamilyActivitySelection) {
        if let data = try? JSONEncoder().encode(selection) {
            defaults.set(data, forKey: selectionKey)
        }
    }

    @available(iOS 26.0, *)
    static func hasSelection(_ selection: FamilyActivitySelection? = nil) -> Bool {
        let value = selection ?? loadSelection()
        return !value.applicationTokens.isEmpty || !value.categoryTokens.isEmpty || !value.webDomainTokens.isEmpty
    }
    #endif

    #if canImport(DeviceActivity)
    @available(iOS 26.0, *)
    static func filter(for range: String) -> DeviceActivityFilter {
        let now = Date()
        let cal = Calendar.current
        let interval: DateInterval
        if range == "week" {
            let start = cal.date(byAdding: .day, value: -6, to: cal.startOfDay(for: now)) ?? now
            interval = DateInterval(start: start, end: now)
        } else {
            interval = DateInterval(start: cal.startOfDay(for: now), end: now)
        }
        let segment: DeviceActivityFilter.SegmentInterval =
            range == "week" ? .daily(during: interval) : .hourly(during: interval)
        #if canImport(FamilyControls)
        let selection = loadSelection()
        if hasSelection(selection) {
            return DeviceActivityFilter(
                segment: segment,
                users: .all,
                applications: selection.applicationTokens,
                categories: selection.categoryTokens,
                webDomains: selection.webDomainTokens
            )
        }
        #endif
        return DeviceActivityFilter(segment: segment, users: .all)
    }
    #endif
}
