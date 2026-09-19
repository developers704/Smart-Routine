import Foundation
import Capacitor
import UIKit
#if canImport(FamilyControls)
import FamilyControls
#endif
#if canImport(SwiftUI)
import SwiftUI
#endif

/// Capacitor 8 local plugin. Screen Time numbers and FamilyActivity tokens stay
/// in Swift / the DeviceActivityReport extension — this bridge only returns
/// support flags, authorization status, and whether a selection exists.
@objc(ScreenTimePlugin)
public class ScreenTimePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenTimePlugin"
    public let jsName = "ScreenTime"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAuthorizationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentActivityPicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attachReport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detachReport", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        // Never prompt for Family Controls from load() — only Enable App Activity.
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        once.resolve(supportPayload())
    }

    @objc func getAuthorizationStatus(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        once.resolve(statusPayload())
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if canImport(FamilyControls)
        if #available(iOS 26.0, *) {
            Task {
                let member = call.getString("member") ?? "individual"
                do {
                    if member == "children-report" {
                        // Parent iPhone: Apple documents DeviceActivityFilter.users = .children
                        // after the *child* device authorized with .child and a guardian approved.
                        // Do not call requestAuthorization(for: .child) here — that must run on
                        // Anika’s iPhone (child iCloud account).
                        ScreenTimeStore.setUsersMode("children")
                        once.resolve(self.statusPayload())
                    } else if member == "child" {
                        try await AuthorizationCenter.shared.requestAuthorization(for: .child)
                        ScreenTimeStore.setUsersMode("all")
                        once.resolve(self.statusPayload())
                    } else {
                        try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                        ScreenTimeStore.setUsersMode("all")
                        once.resolve(self.statusPayload())
                    }
                } catch {
                    once.resolve(self.statusPayload(error: String(describing: error), member: member))
                }
            }
            return
        }
        #endif
        once.resolve(statusPayload())
    }

    @objc func presentActivityPicker(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if canImport(FamilyControls) && canImport(SwiftUI)
        if #available(iOS 26.0, *) {
            DispatchQueue.main.async {
                guard let vc = self.bridge?.viewController else {
                    once.resolve(["ok": false, "reason": "no-view"])
                    return
                }
                let sheet = ScreenTimePickerSheet {
                    vc.dismiss(animated: true) {
                        var payload = self.statusPayload()
                        payload["ok"] = true
                        once.resolve(payload)
                    }
                }
                let host = UIHostingController(rootView: sheet)
                vc.present(host, animated: true)
            }
            return
        }
        #endif
        once.resolve(["ok": false, "reason": "requires-ios-26"])
    }

    @objc func attachReport(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        let range = call.getString("range") == "week" ? "week" : "today"
        ScreenTimeStore.setRange(range)
        let top = CGFloat(call.getDouble("top") ?? 0)
        let left = CGFloat(call.getDouble("left") ?? 0)
        let width = CGFloat(call.getDouble("width") ?? 0)
        let height = CGFloat(call.getDouble("height") ?? 0)
        #if canImport(DeviceActivity)
        if #available(iOS 26.0, *) {
            DispatchQueue.main.async {
                guard let vc = self.bridge?.viewController else {
                    once.resolve(["ok": false, "reason": "no-view"])
                    return
                }
                let raw = CGRect(x: left, y: top, width: max(width, 0), height: max(height, 0))
                let frame = self.bridge?.webView.map { $0.convert(raw, to: vc.view) } ?? raw
                ScreenTimeOverlay.attach(on: vc, frame: frame, range: range)
                once.resolve(["ok": true, "range": range])
            }
            return
        }
        #endif
        once.resolve(["ok": false, "reason": "requires-ios-26"])
    }

    @objc func detachReport(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        DispatchQueue.main.async {
            ScreenTimeOverlay.detach()
            once.resolve(["ok": true])
        }
    }

    private func supportPayload() -> [String: Any] {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let osVersion = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        #if canImport(FamilyControls)
        if #available(iOS 26.0, *) {
            return [
                "supported": true,
                "osVersion": osVersion,
                "osMajor": os.majorVersion
            ]
        }
        #endif
        return [
            "supported": false,
            "reason": "requires-ios-26",
            "osVersion": osVersion,
            "osMajor": os.majorVersion
        ]
    }

    private func statusPayload(error: String? = nil, member: String? = nil) -> [String: Any] {
        var payload = supportPayload()
        payload["authorization"] = authorizationLabel()
        payload["hasSelection"] = false
        payload["users"] = ScreenTimeStore.usersMode()
        #if canImport(FamilyControls)
        if #available(iOS 26.0, *) {
            payload["hasSelection"] = ScreenTimeStore.hasSelection()
        }
        #endif
        if let error {
            payload["error"] = error
            payload["ok"] = false
            let lower = error.lowercased()
            payload["familySharingRequired"] =
                member == "child" || lower.contains("family") || lower.contains("guardian") || lower.contains("child")
        } else {
            payload["ok"] = payload["authorization"] as? String == "authorized"
        }
        return payload
    }

    private func authorizationLabel() -> String {
        #if canImport(FamilyControls)
        if #available(iOS 26.0, *) {
            switch AuthorizationCenter.shared.authorizationStatus {
            case .approved: return "authorized"
            case .denied: return "denied"
            case .notDetermined: return "notDetermined"
            @unknown default: return "unknown"
            }
        }
        #endif
        return "unavailable"
    }
}
