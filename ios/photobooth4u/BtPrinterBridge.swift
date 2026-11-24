import Foundation
import UIKit
import CoreBluetooth

/**
 * photobooth4u — iPad Bluetooth receipt-printer bridge (window.__BTBridge)
 *
 * The booth page already knows how to print to a Bluetooth thermal printer through `window.__BTBridge`
 * (the Android app provides it). This is the iPad version, built on CoreBluetooth.
 *
 * What an iPad can and cannot do:
 *   - Bluetooth LOW ENERGY (BLE) printers work: FunPrint / LIOTOG C19 and other "cat" printers, WalkPrint, and the
 *     BLE models of ESC/POS receipt printers.
 *   - "Classic" Bluetooth (SPP / RFCOMM) printers do NOT work: iPadOS only lets Apple-certified (MFi) accessories use
 *     that. Many 80 mm receipt printers are classic-only; the connect message says so when no BLE channel is found.
 *   - BLE printers are not paired in Settings. The app scans, the operator picks the printer once, and the app remembers it.
 *
 * Every call from the page is an asynchronous message (so the camera picture never waits for the printer);
 * answers go back through window.__pbBtResolve(id, json), and printer events through window.__BTEvent({...}).
 * Everything runs on the main queue.
 */
final class BtPrinterBridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {

    static let shared = BtPrinterBridge()

    /// Runs JavaScript in the booth page (set by the view controller).
    var evaluate: ((String) -> Void)?
    /// The screen the printer chooser is shown from (set by the view controller).
    var presenter: (() -> UIViewController?)?

    private let idKey = "pb4u_bt_id"
    private let nameKey = "pb4u_bt_name"

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var writeChar: CBCharacteristic?
    private var connectedName = ""
    private var proto = ""
    private var ready = false

    // MARK: Known printers

    // Service UUIDs of BLE thermal printers, in the order they are preferred (full lower-case form).
    private let serviceOrder: [String] = [
        "0000ae30-0000-1000-8000-00805f9b34fb",
        "0000ae00-0000-1000-8000-00805f9b34fb",
        "0000ff00-0000-1000-8000-00805f9b34fb",
        "000018f0-0000-1000-8000-00805f9b34fb",
        "0000e781-0000-1000-8000-00805f9b34fb",
        "0000ffe0-0000-1000-8000-00805f9b34fb",
        "0000fff0-0000-1000-8000-00805f9b34fb",
        "49535343-fe7d-4ae5-8fa9-9fafd205e455",
        "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
        "e7810a71-73ae-499d-8c15-faa9aef0c3f2"
    ]
    private let catServices: Set<String> = [
        "0000ae30-0000-1000-8000-00805f9b34fb",
        "0000ae00-0000-1000-8000-00805f9b34fb"
    ]
    private let namePrefixes: [String] = [
        "C19", "LIOTOG", "MX0", "MX1", "GB0", "GT0", "YT0", "PD01",
        "T80", "T58", "T-80", "T-58", "T9",
        "XP", "Xprinter", "TM", "Epson", "POS", "Receipt", "Thermal", "RPP", "Bixolon", "Star", "MP", "BP",
        "PT", "ZJ", "NT", "Netum", "Printer", "MTP", "MPT", "Inner", "Qsprinter", "Goojprt", "Munbyn", "Milestone",
        "HOIN", "Sunmi", "Imin", "Diyep", "RP", "Rongta", "HPRT", "Gprinter", "GP-", "iDPRT", "TSP", "P300",
        "VOZY", "VOXY", "G80", "V80", "P50", "GZ", "GZM", "GZQIANJI"
    ]
    private let catPrefixes: [String] = ["C19", "LIOTOG", "MX0", "MX1", "GB0", "GT0", "YT0", "PD01"]

    // MARK: Connect state

    private struct Candidate {
        let p: CBPeripheral
        let name: String
        let likely: Bool
        let rssi: Int
    }

    private var found: [UUID: Candidate] = [:]
    private var scanning = false
    private var scanFinish: ((String) -> Void)?
    private var savedTarget: UUID?
    private var busyConnecting = false
    private var stateWaiters: [(String?) -> Void] = []
    private var openFinish: ((String) -> Void)?
    private var openTimeout: DispatchWorkItem?
    private var connectGuard: DispatchWorkItem?
    private var charsPending = 0

    // MARK: Write state

    private struct Job {
        let data: Data
        let chunk: Int
        let delayMs: Int
        let done: (String) -> Void
    }

    private var jobs: [Job] = []
    private var current: Job?
    private var offset = 0
    private var jobToken = 0
    private var waitingReady = false
    private var waitingResponse = false
    private var progressGuard: DispatchWorkItem?

    // MARK: - Calls from the page

    /// The printer remembered from the last time, for the page's first look (before any message is sent).
    func initialStateJson() -> String {
        return json(stateDict())
    }

    func handle(id: Int, op: String, args: [String: Any]) {
        switch op {
        case "connect":
            connect(saved: false) { [weak self] result in self?.reply(id, result) }
        case "connectSaved":
            connect(saved: true) { [weak self] result in
                guard let self = self else { return }
                var d = self.parse(result)
                d["type"] = "reconnect"
                if let uuid = UserDefaults.standard.string(forKey: self.idKey) { d["address"] = uuid }
                self.emit(d)
            }
        case "write":
            let data = Data(base64Encoded: (args["b64"] as? String) ?? "", options: .ignoreUnknownCharacters) ?? Data()
            enqueue(data, chunk: 100, delayMs: 12) { [weak self] result in self?.reply(id, result) }
        case "writePaced":
            let data = Data(base64Encoded: (args["b64"] as? String) ?? "", options: .ignoreUnknownCharacters) ?? Data()
            let chunk = max(16, min(4096, (args["chunk"] as? NSNumber)?.intValue ?? 100))
            let delay = max(0, min(500, (args["delay"] as? NSNumber)?.intValue ?? 0))
            enqueue(data, chunk: chunk, delayMs: delay) { [weak self] result in self?.reply(id, result) }
        case "release":
            closeLink(forget: false)
            reply(id, "{\"ok\":true}")
        case "disconnect":
            closeLink(forget: true)
            reply(id, "{\"ok\":true}")
        case "settings":
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            reply(id, "{\"ok\":true}")
        default:
            reply(id, failJson("Unknown Bluetooth request."))
        }
    }

    // MARK: - Connecting

    private func connect(saved: Bool, done: @escaping (String) -> Void) {
        if ready, let p = peripheral, p.state == .connected {
            done(connectedJson())
            return
        }
        if busyConnecting {
            done(failJson("Still connecting. Please wait a moment."))
            return
        }
        if saved && savedId() == nil {
            done(failJson("No Bluetooth printer chosen yet", none: true))
            return
        }
        busyConnecting = true
        let finish: (String) -> Void = { [weak self] result in
            guard let self = self else { return }
            self.connectGuard?.cancel()
            self.connectGuard = nil
            self.busyConnecting = false
            done(result)
        }
        // One way or another this ends: a Bluetooth permission box nobody answers must not hang the page.
        let guardItem = DispatchWorkItem { [weak self] in
            guard let self = self, self.busyConnecting else { return }
            self.stopScan()
            self.scanFinish = nil
            self.savedTarget = nil
            self.abandonOpen()
            finish(self.failJson("The printer did not answer. Switch it on, keep it close to the iPad, and try again."))
        }
        connectGuard = guardItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 45.0, execute: guardItem)

        whenPoweredOn { [weak self] problem in
            guard let self = self else { return }
            if let problem = problem {
                finish(problem)
                return
            }
            if saved { self.connectSavedPrinter(finish) } else { self.scanAndPick(finish) }
        }
    }

    private func whenPoweredOn(_ callback: @escaping (String?) -> Void) {
        if central == nil {
            central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: true])
        }
        switch central?.state ?? .unknown {
        case .poweredOn:
            callback(nil)
        case .poweredOff:
            callback(failJson("Bluetooth is turned off. Switch it on in Control Center.", adapterOff: true))
        case .unauthorized:
            callback(failJson("Bluetooth is not allowed for photobooth4u. Turn it on in Settings, then photobooth4u."))
        case .unsupported:
            callback(failJson("This iPad has no Bluetooth."))
        default:
            stateWaiters.append(callback)      // not known yet (or just restarting): answered in centralManagerDidUpdateState
        }
    }

    private func scanAndPick(_ finish: @escaping (String) -> Void) {
        found = [:]
        savedTarget = nil
        scanFinish = finish
        scanning = true
        central?.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) { [weak self] in
            guard let self = self, self.scanning, self.savedTarget == nil else { return }
            self.stopScan()
            guard let done = self.scanFinish else { return }
            self.scanFinish = nil
            let all = Array(self.found.values)
            let likely = all.filter { $0.likely }.sorted { $0.rssi > $1.rssi }
            let list = likely.isEmpty ? all.sorted { $0.rssi > $1.rssi } : likely
            if list.isEmpty {
                done(self.failJson("No Bluetooth printer found. Switch the printer on, keep it next to the iPad, and try again. (Only Bluetooth LE printers work on an iPad; classic Bluetooth printers do not.)"))
                return
            }
            if likely.count == 1 {
                self.open(likely[0].p, done)
            } else {
                self.choose(list, done)
            }
        }
    }

    private func connectSavedPrinter(_ finish: @escaping (String) -> Void) {
        guard let uuid = savedId() else {
            finish(failJson("No Bluetooth printer chosen yet", none: true))
            return
        }
        if let p = central?.retrievePeripherals(withIdentifiers: [uuid]).first {
            open(p, finish)
            return
        }
        // The iPad no longer lists it: look for it for a few seconds.
        found = [:]
        savedTarget = uuid
        scanFinish = finish
        scanning = true
        central?.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        DispatchQueue.main.asyncAfter(deadline: .now() + 8.0) { [weak self] in
            guard let self = self, self.scanning, self.savedTarget != nil else { return }
            self.stopScan()
            self.savedTarget = nil
            guard let done = self.scanFinish else { return }
            self.scanFinish = nil
            done(self.failJson("The printer did not answer"))
        }
    }

    private func stopScan() {
        if scanning { central?.stopScan() }
        scanning = false
    }

    private func choose(_ list: [Candidate], _ finish: @escaping (String) -> Void) {
        guard let host = presenter?() else {
            finish(failJson("Could not show the printer list."))
            return
        }
        connectGuard?.cancel()      // the operator is choosing: no time limit while the list is on screen
        connectGuard = nil
        let sheet = UIAlertController(title: "Choose your printer", message: "Bluetooth printers near this iPad", preferredStyle: .actionSheet)
        for c in list.prefix(12) {
            sheet.addAction(UIAlertAction(title: c.name, style: .default) { [weak self] _ in
                self?.open(c.p, finish)
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            finish(self?.failJson("No printer chosen.") ?? "{\"ok\":false}")
        })
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = host.view
            pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        host.present(sheet, animated: true)
    }

    /// Links to one printer, finds its writable channel, and answers with the connected json.
    private func open(_ p: CBPeripheral, _ finish: @escaping (String) -> Void) {
        stopScan()
        resetLink()
        peripheral = p
        p.delegate = self
        connectedName = found[p.identifier]?.name ?? (p.name ?? "Bluetooth printer")
        openFinish = finish
        let item = DispatchWorkItem { [weak self] in
            guard let self = self, let done = self.openFinish else { return }
            self.openFinish = nil
            self.abandonOpen()
            done(self.failJson("The printer did not answer. Switch it on, keep it close to the iPad, and try again."))
        }
        openTimeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 15.0, execute: item)
        central?.connect(p, options: nil)
    }

    private func abandonOpen() {
        openTimeout?.cancel()
        openTimeout = nil
        openFinish = nil
        if let p = peripheral, !ready { central?.cancelPeripheralConnection(p) }
        if !ready { peripheral = nil }
    }

    private func finishOpen(_ result: String) {
        openTimeout?.cancel()
        openTimeout = nil
        guard let done = openFinish else { return }
        openFinish = nil
        done(result)
    }

    private func pickWriteChannel(_ p: CBPeripheral) {
        var best: (rank: Int, char: CBCharacteristic, service: String)?
        var notify: CBCharacteristic?
        for s in p.services ?? [] {
            let sid = full(s.uuid)
            let svcRank = serviceOrder.firstIndex(of: sid) ?? 99
            for c in s.characteristics ?? [] {
                let cid = full(c.uuid)
                if c.properties.contains(.notify) && (cid.contains("ae02") || cid.contains("ff01") || cid.contains("ff03")) && notify == nil {
                    notify = c
                }
                if c.properties.contains(.writeWithoutResponse) || c.properties.contains(.write) {
                    let pref = (cid.contains("ae01") || cid.contains("ff02")) ? 0 : 1
                    let rank = svcRank * 10 + pref
                    if best == nil || rank < best!.rank { best = (rank, c, sid) }
                }
            }
        }
        guard let chosen = best else {
            failOpen("No Bluetooth LE print channel found on \(connectedName). This printer is probably a classic Bluetooth model, which an iPad cannot use. Use a Bluetooth LE printer, or a Wi-Fi / AirPrint printer.")
            return
        }
        if let n = notify { p.setNotifyValue(true, for: n) }
        writeChar = chosen.char
        proto = (catServices.contains(chosen.service) || catPrefixes.contains { connectedName.lowercased().hasPrefix($0.lowercased()) }) ? "cat" : ""
        ready = true
        UserDefaults.standard.set(p.identifier.uuidString, forKey: idKey)
        UserDefaults.standard.set(connectedName, forKey: nameKey)
        pushState()
        finishOpen(connectedJson())
    }

    /// The link to the chosen printer could not be used: drop it and answer the page's connect call.
    private func failOpen(_ message: String) {
        let done = openFinish
        openFinish = nil
        openTimeout?.cancel()
        openTimeout = nil
        if let p = peripheral, !ready { central?.cancelPeripheralConnection(p) }
        if !ready { peripheral = nil }
        done?(failJson(message))
    }

    // MARK: - Closing

    private func resetLink() {
        failAllJobs("Printer disconnected.")
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        peripheral = nil
        writeChar = nil
        ready = false
        proto = ""
    }

    /// forget = true also clears the remembered printer (the page's Disconnect / Change).
    private func closeLink(forget: Bool) {
        resetLink()
        connectedName = ""
        if forget {
            UserDefaults.standard.removeObject(forKey: idKey)
            UserDefaults.standard.removeObject(forKey: nameKey)
        }
        pushState()
    }

    private func linkLost() {
        let wasReady = ready
        failAllJobs("Printer disconnected.")
        if let done = openFinish {
            openFinish = nil
            openTimeout?.cancel()
            done(failJson("The printer disconnected."))
        }
        peripheral = nil
        writeChar = nil
        ready = false
        pushState()
        if wasReady { emit(["type": "link", "on": false]) }
    }

    // MARK: - Writing

    private func enqueue(_ data: Data, chunk: Int, delayMs: Int, done: @escaping (String) -> Void) {
        guard ready, peripheral != nil, writeChar != nil else {
            done(failJson("Printer not connected."))
            return
        }
        if data.isEmpty {
            done("{\"ok\":true}")
            return
        }
        jobs.append(Job(data: data, chunk: chunk, delayMs: delayMs, done: done))
        startNextJob()
    }

    private func startNextJob() {
        guard current == nil, !jobs.isEmpty else { return }
        current = jobs.removeFirst()
        offset = 0
        jobToken += 1
        pump()
    }

    private func pump() {
        guard let job = current else { return }
        guard ready, let p = peripheral, let ch = writeChar else {
            failCurrent("Printer disconnected.")
            return
        }
        if offset >= job.data.count {
            let token = jobToken
            let pause = Double(job.delayMs) * 4.0 / 1000.0      // let the printer take the last piece before the next request
            DispatchQueue.main.asyncAfter(deadline: .now() + pause) { [weak self] in
                guard let self = self, token == self.jobToken, let j = self.current else { return }
                self.progressGuard?.cancel()
                self.current = nil
                j.done("{\"ok\":true}")
                self.startNextJob()
            }
            return
        }
        let noResponse = ch.properties.contains(.writeWithoutResponse)
        let type: CBCharacteristicWriteType = noResponse ? .withoutResponse : .withResponse
        if noResponse && !p.canSendWriteWithoutResponse {
            waitingReady = true
            armProgressGuard()
            return
        }
        let room = max(20, p.maximumWriteValueLength(for: type))
        let n = min(job.chunk, room, job.data.count - offset)
        let piece = job.data.subdata(in: offset..<(offset + n))
        offset += n
        p.writeValue(piece, for: ch, type: type)
        armProgressGuard()
        if noResponse {
            scheduleNextPump(job.delayMs)
        } else {
            waitingResponse = true
        }
    }

    private func scheduleNextPump(_ delayMs: Int) {
        let token = jobToken
        let run: () -> Void = { [weak self] in
            guard let self = self, token == self.jobToken else { return }
            self.pump()
        }
        if delayMs <= 0 {
            DispatchQueue.main.async(execute: run)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(delayMs) / 1000.0, execute: run)
        }
    }

    private func armProgressGuard() {
        progressGuard?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self, self.current != nil else { return }
            self.failCurrent("The printer stopped answering.")
            if let p = self.peripheral { self.central?.cancelPeripheralConnection(p) }
        }
        progressGuard = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 15.0, execute: item)
    }

    private func failCurrent(_ message: String) {
        progressGuard?.cancel()
        jobToken += 1
        waitingReady = false
        waitingResponse = false
        let job = current
        current = nil
        job?.done(failJson(message))
        failQueued(message)
    }

    private func failQueued(_ message: String) {
        let waiting = jobs
        jobs = []
        waiting.forEach { $0.done(failJson(message)) }
    }

    private func failAllJobs(_ message: String) {
        if current != nil { failCurrent(message) } else { failQueued(message) }
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        pushState()
        switch central.state {
        case .poweredOff:
            linkLost()
            emit(["type": "adapter", "on": false])
        case .poweredOn:
            emit(["type": "adapter", "on": true])
        default:
            break
        }
        let waiting = stateWaiters
        stateWaiters = []
        waiting.forEach { whenPoweredOn($0) }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard scanning else { return }
        let advName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
        let name = advName.trimmingCharacters(in: .whitespacesAndNewlines)
        let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let hasService = services.contains { serviceOrder.contains(full($0)) }
        let nameMatch = !name.isEmpty && namePrefixes.contains { name.lowercased().hasPrefix($0.lowercased()) }
        if isNonPrinterName(name) { return }
        if name.isEmpty && !hasService && peripheral.identifier != savedTarget { return }
        found[peripheral.identifier] = Candidate(p: peripheral, name: name.isEmpty ? "Bluetooth printer" : name, likely: hasService || nameMatch, rssi: RSSI.intValue)
        if let want = savedTarget, peripheral.identifier == want {
            stopScan()
            savedTarget = nil
            if let done = scanFinish {
                scanFinish = nil
                open(peripheral, done)
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral === self.peripheral else { return }
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }
        failOpen("Could not connect to \(connectedName).")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }
        linkLost()
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === self.peripheral else { return }
        let services = peripheral.services ?? []
        if error != nil || services.isEmpty {
            failOpen("Could not read the printer's services on \(connectedName).")
            return
        }
        charsPending = services.count
        for s in services { peripheral.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard peripheral === self.peripheral, !ready else { return }
        charsPending -= 1
        if charsPending <= 0 {
            pickWriteChannel(peripheral)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard waitingResponse, let job = current else { return }
        waitingResponse = false
        if error != nil {
            failCurrent("Write failed.")
            return
        }
        scheduleNextPump(job.delayMs)
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        guard waitingReady else { return }
        waitingReady = false
        pump()
    }

    // MARK: - Page plumbing

    private func savedId() -> UUID? {
        guard let s = UserDefaults.standard.string(forKey: idKey), !s.isEmpty else { return nil }
        return UUID(uuidString: s)
    }

    private func stateDict() -> [String: Any] {
        let on = central == nil ? true : (central?.state != .poweredOff)
        let saved: [String: Any] = [
            "address": UserDefaults.standard.string(forKey: idKey) ?? "",
            "name": UserDefaults.standard.string(forKey: nameKey) ?? ""
        ]
        return [
            "on": on,
            "connected": ready && peripheral?.state == .connected,
            "name": connectedName,
            "proto": proto,
            "saved": saved
        ]
    }

    /// Tells the page the current state (it keeps a copy so isConnected() / isEnabled() can answer at once).
    func pushState() {
        evaluate?("window.__pbBtState && window.__pbBtState(\(json(stateDict())));")
    }

    private func emit(_ d: [String: Any]) {
        evaluate?("window.__BTEvent && window.__BTEvent(\(json(d)));")
    }

    private func reply(_ id: Int, _ result: String) {
        if id == 0 { return }
        let literal = json([result])      // ["..."]: a safe way to pass any text to JavaScript
        evaluate?("window.__pbBtResolve && window.__pbBtResolve(\(id), (\(literal))[0]);")
    }

    private func connectedJson() -> String {
        return json([
            "ok": true,
            "name": connectedName,
            "address": peripheral?.identifier.uuidString ?? "",
            "proto": proto
        ])
    }

    private func failJson(_ message: String, adapterOff: Bool = false, none: Bool = false) -> String {
        var d: [String: Any] = ["ok": false, "error": message]
        if adapterOff { d["adapterOff"] = true }
        if none { d["none"] = true }
        return json(d)
    }

    private func parse(_ text: String) -> [String: Any] {
        guard let data = text.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else { return [:] }
        return obj
    }

    private func json(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: []),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private func full(_ u: CBUUID) -> String {
        let s = u.uuidString.lowercased()
        if s.count == 4 { return "0000\(s)-0000-1000-8000-00805f9b34fb" }
        if s.count == 8 { return "\(s)-0000-1000-8000-00805f9b34fb" }
        return s
    }

    private func isNonPrinterName(_ name: String) -> Bool {
        let n = name.lowercased()
        let bad = ["keyboard", "mouse", "headset", "headphone", "earbud", "airpod", "speaker", "audio", "watch", "band", "remote", "controller", "tv", "iphone", "ipad", "macbook"]
        return bad.contains { n.contains($0) }
    }
}
