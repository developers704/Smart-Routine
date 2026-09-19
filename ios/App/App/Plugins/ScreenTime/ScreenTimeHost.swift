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
    private static var range: String?

    static func detach() {
        guard let host else { return }
        host.willMove(toParent: nil)
        host.view.removeFromSuperview()
        host.removeFromParent()
        self.host = nil
        range = nil
    }

    static func attach(on parent: UIViewController, frame: CGRect, range: String) {
        if let host, host.view.superview === parent.view, self.range == range {
            apply(frame, to: host.view)
            return
        }
        detach()
        guard #available(iOS 26.0, *) else { return }
        let hc = UIHostingController(rootView: ScreenTimeReportContainer(range: range))
        hc.view.backgroundColor = UIColor(red: 1, green: 0.969, blue: 0.980, alpha: 1)
        hc.view.autoresizingMask = []
        hc.view.isUserInteractionEnabled = false
        apply(frame, to: hc.view)
        parent.addChild(hc)
        parent.view.addSubview(hc.view)
        hc.didMove(toParent: parent)
        self.host = hc
        self.range = range
    }

    private static func apply(_ frame: CGRect, to view: UIView) {
        view.frame = frame
        view.clipsToBounds = true
        view.layer.cornerRadius = 22
        view.isHidden = frame.height < 32 || frame.width < 24
    }
}
