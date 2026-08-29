import SwiftUI
import WidgetKit
import ActivityKit
import AlarmKit

/// Live Activity / Dynamic Island for AlarmKit countdown and alert states.
///
/// Apple warns that countdown alarms without this widget extension can dismiss
/// unexpectedly or fail to alert. This target deploys at iOS 26.0 because it
/// imports AlarmKit; the main App target stays iOS 17.0.
///
/// No App Group is configured: AlarmKit delivers `AlarmAttributes` to the
/// widget itself. Signing: the widget bundle id is
/// `app.routine.calendar.RoutineAlarmWidget` and must use the same Team as App.
@available(iOS 26.0, *)
struct RoutineAlarmLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AlarmAttributes<RoutineAlarmMetadata>.self) { context in
            lockScreen(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Smart Routine")
                            .font(.caption2)
                        Text(context.attributes.metadata?.title ?? "Alarm")
                            .font(.headline)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    countdownText(context)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(modeLabel(context))
                        .font(.caption)
                }
            } compactLeading: {
                Image(systemName: "alarm.fill")
            } compactTrailing: {
                countdownText(context)
            } minimal: {
                Image(systemName: "alarm.fill")
            }
        }
    }

    @ViewBuilder
    private func lockScreen(context: ActivityViewContext<AlarmAttributes<RoutineAlarmMetadata>>) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(context.attributes.metadata?.title ?? "Smart Routine")
                    .font(.headline)
                Text(modeLabel(context))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            countdownText(context)
                .font(.title2.monospacedDigit())
        }
        .padding()
        .tint(RoutineAlarmStyle.tint)
    }

    @ViewBuilder
    private func countdownText(_ context: ActivityViewContext<AlarmAttributes<RoutineAlarmMetadata>>) -> some View {
        switch context.state.mode {
        case .countdown(let countdown):
            Text(timerInterval: countdown.startDate...countdown.fireDate, countsDown: true)
        case .paused:
            Text("Paused")
        default:
            Image(systemName: "alarm.fill")
        }
    }

    private func modeLabel(_ context: ActivityViewContext<AlarmAttributes<RoutineAlarmMetadata>>) -> String {
        if case .countdown = context.state.mode { return "Snoozing" }
        if case .paused = context.state.mode { return "Paused" }
        return "Alarm"
    }
}

@available(iOS 26.0, *)
@main
struct RoutineAlarmWidgetBundle: WidgetBundle {
    var body: some Widget {
        RoutineAlarmLiveActivity()
    }
}
