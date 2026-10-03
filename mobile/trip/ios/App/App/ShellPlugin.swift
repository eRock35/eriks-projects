// Shared by all four iPhone apps. Edit it in mobile/template/ios/ and run
// `npm run generate` in mobile/ - the copies under each app's ios/ are output.
//
// Where a link opens. The rule, in order:
//
//  1. The app's own host and *.strongtechnicalconsulting.com (the shared
//     sign-in) stay in the app - capacitor.config.json's server.url and
//     server.allowNavigation are the list.
//  2. Anything that is not http(s) - tel:, mailto:, sms: - is left to
//     Capacitor, which hands it to iOS.
//  3. Any other web link: if an installed app claims it as a universal link
//     (Google Maps, Uber, Untappd, DraftKings), that app opens. Apple Maps
//     links open Maps. Everything else - Stripe checkout included - opens in
//     an in-app Safari sheet (SFSafariViewController), so the person is one
//     "Done" away from where they were.
//
// It also opens a universal link (a link to the app's site tapped in Mail or
// Messages) at that page, so links work without any change to the web app.
// When the web side starts listening to @capacitor/app's appUrlOpen (phase
// 2), remove that half or the page loads twice.

import UIKit
import WebKit
import SafariServices
import Capacitor

@objc(ShellPlugin)
public class ShellPlugin: CAPPlugin, CAPBridgedPlugin, SFSafariViewControllerDelegate {
    public let identifier = "ShellPlugin"
    public let jsName = "Shell"
    public let pluginMethods: [CAPPluginMethod] = []

    /// Set while a Stripe page is open: when it closes, the app page reloads
    /// so a purchase made there shows straight away.
    private var reloadWhenSafariCloses = false

    override public func load() {
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(openUniversalLink(_:)),
                                               name: .capacitorOpenUniversalLink,
                                               object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Navigation inside the web view

    @objc override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, isWeb(url) else { return nil }
        if isInApp(url) { return nil }
        // Only a page-level navigation leaves the app. A frame inside the page
        // (a payment field, an embedded map) loads where it is.
        let topLevel = navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true
        guard topLevel else { return nil }
        openOutside(url)
        return true
    }

    /// target="_blank" and window.open(), via AppViewController's proxy.
    func openNewWindow(from webView: WKWebView, action: WKNavigationAction) {
        guard let url = action.request.url else { return }
        if isWeb(url), isInApp(url) {
            // One of our own pages asked for a new window: there is only one.
            webView.load(action.request)
        } else if isWeb(url) {
            openOutside(url)
        } else {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }

    // MARK: - Universal links

    @objc private func openUniversalLink(_ notification: Notification) {
        guard let payload = notification.object as? [String: Any],
              let url = payload["url"] as? URL,
              isWeb(url), isInApp(url) else { return }
        DispatchQueue.main.async { [weak self] in
            _ = self?.bridge?.webView?.load(URLRequest(url: url))
        }
    }

    // MARK: - Leaving the app

    private func openOutside(_ url: URL) {
        DispatchQueue.main.async {
            let host = url.host?.lowercased() ?? ""
            if host == "maps.apple.com" {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                return
            }
            UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { [weak self] opened in
                if !opened { self?.presentSafari(url) }
            }
        }
    }

    private func presentSafari(_ url: URL) {
        guard let root = bridge?.viewController else {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            return
        }
        var presenter: UIViewController = root
        while let next = presenter.presentedViewController { presenter = next }
        if presenter is SFSafariViewController {
            // A second link while one sheet is open: open it in Safari proper
            // rather than stacking sheets.
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            return
        }
        let safari = SFSafariViewController(url: url)
        safari.delegate = self
        safari.dismissButtonStyle = .done
        let host = url.host?.lowercased() ?? ""
        reloadWhenSafariCloses = host == "stripe.com" || host.hasSuffix(".stripe.com")
        presenter.present(safari, animated: true, completion: nil)
    }

    public func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        if reloadWhenSafariCloses {
            reloadWhenSafariCloses = false
            bridge?.webView?.reload()
        }
    }

    // MARK: - Helpers

    private func isWeb(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "https" || scheme == "http"
    }

    private func isInApp(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased(), let config = bridge?.config else { return false }
        if host == config.serverURL.host?.lowercased() { return true }
        return config.shouldAllowNavigation(to: host)
    }
}
