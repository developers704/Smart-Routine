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
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
    private static var clip: UIView?
    private static var range: String = "today"

    static func detach() {
        host?.willMove(toParent: nil)
        host?.view.removeFromSuperview()
        host?.removeFromParent()
        clip?.removeFromSuperview()
        host = nil
        clip = nil
    }

    static func attach(on parent: UIViewController, webView: UIView, cssFrame: CGRect, range: String) {
        let frame = webView.convert(cssFrame, to: parent.view)
        if host?.parent === parent, clip?.superview === parent.view, self.range == range {
            updateFrame(frame)
            return
        }
        detach()
        guard #available(iOS 26.0, *) else { return }
        self.range = range
        let pocket = UIView(frame: frame)
        pocket.clipsToBounds = true
        pocket.layer.cornerRadius = 18
        pocket.layer.cornerCurve = .continuous
        pocket.backgroundColor = .clear
        parent.view.addSubview(pocket)
        clip = pocket

        let hc = UIHostingController(rootView: ScreenTimeReportContainer(range: range))
        hc.view.backgroundColor = .clear
        hc.view.frame = pocket.bounds
        hc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        hc.view.clipsToBounds = true
        parent.addChild(hc)
        pocket.addSubview(hc.view)
        hc.didMove(toParent: parent)
        host = hc
    }

    static func updateFrame(_ frame: CGRect) {
        clip?.frame = frame
        host?.view.frame = clip?.bounds ?? frame
        if frame.width < 8 || frame.height < 8 {
            clip?.isHidden = true
        } else {
            clip?.isHidden = false
        }
    }
}
