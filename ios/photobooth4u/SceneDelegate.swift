import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?
    private var wasBackgrounded = false

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = (scene as? UIWindowScene) else { return }

        let window = UIWindow(windowScene: windowScene)
        let rootVC = ViewController()
        window.rootViewController = rootVC
        self.window = window
        window.makeKeyAndVisible()
    }

    func sceneDidDisconnect(_ scene: UIScene) {}
    func sceneDidBecomeActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = true
        let forceRebind = wasBackgrounded
        wasBackgrounded = false
        LocalShareServer.shared.ensureListening(forceRestart: forceRebind)
        IccCameraHelper.shared.ensureListening(forceRestart: forceRebind)
        NativeCameraBridge.shared.setBackgrounded(false)
    }
    func sceneWillResignActive(_ scene: UIScene) {
        NativeCameraBridge.shared.setBackgrounded(true)
    }
    func sceneWillEnterForeground(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = true
        let forceRebind = wasBackgrounded
        wasBackgrounded = false
        LocalShareServer.shared.ensureListening(forceRestart: forceRebind)
        IccCameraHelper.shared.ensureListening(forceRestart: forceRebind)
        NativeCameraBridge.shared.setBackgrounded(false)
    }
    func sceneDidEnterBackground(_ scene: UIScene) {
        wasBackgrounded = true
        NativeCameraBridge.shared.setBackgrounded(true)
    }
}

