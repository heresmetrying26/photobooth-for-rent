import UIKit

class RovingSceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = (scene as? UIWindowScene) else { return }

        IccCameraHelper.shared.startCameraBrowserOnly()

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = RovingBridgeViewController()
        self.window = window
        window.makeKeyAndVisible()
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        IccCameraHelper.shared.stopCameraBrowserOnly()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = true
        IccCameraHelper.shared.startCameraBrowserOnly()
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = true
        IccCameraHelper.shared.startCameraBrowserOnly()
    }
}
