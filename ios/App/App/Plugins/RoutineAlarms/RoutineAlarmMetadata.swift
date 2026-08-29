import Foundation
import SwiftUI

#if canImport(AlarmKit)
import AlarmKit
#endif

/// App-specific metadata attached to AlarmKit presentations and the Live Activity
/// widget. Compiled into both the App target and RoutineAlarmWidget.
///
/// AlarmKit's `AlarmMetadata` protocol is only present in the iOS 26 SDK, so the
/// conformance is wrapped. The widget target deploys at iOS 26.0 and always
/// sees the real type.
#if canImport(AlarmKit)
@available(iOS 26.0, *)
struct RoutineAlarmMetadata: AlarmMetadata {
    var title: String
    var role: String
    var planId: String
    var isBackup: Bool

    init(title: String, role: String, planId: String, isBackup: Bool = false) {
        self.title = title
        self.role = role
        self.planId = planId
        self.isBackup = isBackup
    }
}
#endif

enum RoutineAlarmStyle {
    /// Smart Routine tint `#C45B78`.
    static let tint = Color(red: 196.0 / 255.0, green: 91.0 / 255.0, blue: 120.0 / 255.0)
}
