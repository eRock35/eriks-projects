// Shared by all four iPhone apps. Edit it in mobile/template/ios/ and run
// `npm run generate` in mobile/ - the copies under each app's ios/ are output.
//
// Capacitor's own view controller, plus one thing: it registers ShellPlugin,
// which decides where a link opens (see ShellPlugin.swift), and puts a thin
// proxy in front of the web view's UI delegate so that target="_blank" links
// and window.open() - which Capacitor hands straight to iOS without asking any
// plugin - go through the same rule.

import UIKit
import WebKit
import Capacitor

class AppViewController: CAPBridgeViewController {
    private let shell = ShellPlugin()
    // WKWebView holds its UI delegate weakly; this keeps the proxy alive.
    private var newWindowProxy: NewWindowProxy?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(shell)

        if let webView = webView, let original = webView.uiDelegate {
            let proxy = NewWindowProxy(original: original) { [weak self] webView, action in
                self?.shell.openNewWindow(from: webView, action: action)
            }
            newWindowProxy = proxy
            webView.uiDelegate = proxy
        }
    }
}

/// Answers createWebViewWith itself and forwards every other WKUIDelegate
/// call (alerts, confirms, camera permission...) to Capacitor's handler.
final class NewWindowProxy: NSObject, WKUIDelegate {
    private weak var original: WKUIDelegate?
    private let onNewWindow: (WKWebView, WKNavigationAction) -> Void

    init(original: WKUIDelegate, onNewWindow: @escaping (WKWebView, WKNavigationAction) -> Void) {
        self.original = original
        self.onNewWindow = onNewWindow
        super.init()
    }

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        onNewWindow(webView, navigationAction)
        return nil
    }

    override func responds(to aSelector: Selector!) -> Bool {
        if super.responds(to: aSelector) { return true }
        return original?.responds(to: aSelector) ?? false
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if let original = original, original.responds(to: aSelector) { return original }
        return super.forwardingTarget(for: aSelector)
    }
}
