import SwiftUI
import AVFoundation
import VisionKit

// Both the booth's QR URL and the app's invitation URL carry the same code.
enum WISSInvitation {
    static func code(from value: String) -> String? {
        guard let url = URLComponents(string: value) else { return nil }
        let code: String?
        if url.scheme == "wissprodmulti", url.host == "join" {
            code = url.queryItems?.first(where: { $0.name == "code" })?.value
        } else if ["https", "http"].contains(url.scheme ?? ""), url.host != nil,
                  url.path == "/booth/join.html" {
            code = url.fragment
        } else { return nil }
        guard let code, code.range(of: "^[0-9A-Fa-f]{12}$", options: .regularExpression) != nil else { return nil }
        return code.uppercased()
    }
}

struct WISSQRScanner: View {
    let onCode: (String) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var authorized = false
    @State private var message = "カメラの使用を許可するとQRを読み取れます"
    @State private var scanned = false

    var body: some View {
        ZStack {
            Color.black
            if authorized, !scanned, scenePhase == .active {
                WISSScannerCamera(onValue: { value in
                    guard !scanned else { return }
                    guard let code = WISSInvitation.code(from: value) else {
                        message = "撮影者画面の「被写体の参加」QRを読み取ってください"
                        return
                    }
                    scanned = true
                    message = "QRを読み取りました"
                    onCode(code)
                }, onError: { message = "カメラを利用できません。参加コードを入力してください" })
            }
            VStack {
                Spacer()
                Text(message).font(.caption).padding(8).background(.black.opacity(0.7)).foregroundStyle(.white)
                if scanned { Button("もう一度読み取る") { scanned = false; message = "参加用QRをカメラに向けてください" }.buttonStyle(.borderedProminent) }
            }.padding(8)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            guard DataScannerViewController.isSupported else {
                message = "この端末ではQRカメラを利用できません。参加コードを入力してください"
                return
            }
            let allowed = await AVCaptureDevice.requestAccess(for: .video)
            authorized = allowed && DataScannerViewController.isAvailable
            message = authorized ? "参加用QRをカメラに向けてください" : "カメラを利用できません。設定で許可するか、参加コードを入力してください"
        }
    }
}

private struct WISSScannerCamera: UIViewControllerRepresentable {
    let onValue: (String) -> Void
    let onError: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }
    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.parent = self
        guard !scanner.isScanning else { return }
        do { try scanner.startScanning() } catch { Task { @MainActor in onError() } }
    }
    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) { scanner.stopScanning() }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var parent: WISSScannerCamera
        init(parent: WISSScannerCamera) { self.parent = parent }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case .barcode(let barcode) = item, let value = barcode.payloadStringValue { parent.onValue(value) }
            }
        }
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) { parent.onError() }
    }
}
