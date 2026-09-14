import SwiftUI
import UIKit
#if canImport(FamilyControls)
import FamilyControls
#endif
#if canImport(DeviceActivity)
import DeviceActivity
#endif

@available(iOS 26.0, *)
struct ScreenTimeReportContainer: View {
    let range: String

    var body: some View {
        #if canImport(DeviceActivity)
        DeviceActivityReport(
            DeviceActivityReport.Context(ScreenTimeStore.contextName),
            filter: ScreenTimeStore.filter(for: range)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #else
        Text("Screen Time reports need DeviceActivity.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        #endif
    }
}

@available(iOS 26.0, *)
struct ScreenTimePickerSheet: View {
    #if canImport(FamilyControls)
    @State private var selection = ScreenTimeStore.loadSelection()
    #endif
    var onDone: () -> Void

    var body: some View {
        NavigationStack {
            #if canImport(FamilyControls)
            FamilyActivityPicker(selection: $selection)
                .navigationTitle("Choose Apps")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            ScreenTimeStore.saveSelection(selection)
                            onDone()
                        }
                    }
                }
            #else
            Text("Family Controls is not available.")
            #endif
        }
    }
}

enum ScreenTimeOverlay {
    private static var host: UIViewController?

    static func detach() {
        guard let host else { return }
        host.willMove(toParent: nil)
        host.view.removeFromSuperview()
        host.removeFromParent()
        self.host = nil
    }

    static func attach(on parent: UIViewController, frame: CGRect, range: String) {
        detach()
        guard #available(iOS 26.0, *) else { return }
        let hc = UIHostingController(rootView: ScreenTimeReportContainer(range: range))
        hc.view.backgroundColor = .clear
        hc.view.frame = frame
        hc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        parent.addChild(hc)
        parent.view.addSubview(hc.view)
        hc.didMove(toParent: parent)
        host = hc
    }
}
