import UIKit

class SpinArmSceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = (scene as? UIWindowScene) else { return }

        let window = UIWindow(windowScene: windowScene)
        window.backgroundColor = UIColor(red: 0x1C / 255.0, green: 0x1A / 255.0, blue: 0x1E / 255.0, alpha: 1.0)
        window.rootViewController = SpinArmGateViewController()
        self.window = window
        window.makeKeyAndVisible()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = true
        if let gate = window?.rootViewController as? SpinArmGateViewController {
            gate.performBackgroundCheckinIfNeeded()
        }
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = true
    }
}
