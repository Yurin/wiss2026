import SwiftUI
import Security
import Photos

struct WISSCredentials: Codable {
    let sessionId: String
    let subjectId: String
    let token: String
}
struct WISSSubject: Decodable, Identifiable {
    let id: String
    let connected: Bool?
}
struct WISSVariant: Decodable, Identifiable {
    let id: String
    let kind: String
    let imageURL: String
    var title: String { ["box": "ボックス", "silhouette": "シルエット", "box_face": "ボックス＋顔位置"][kind] ?? kind }
}
struct WISSReference: Decodable, Identifiable {
    let id: String
    let name: String
    let subjectCount: Int
    let imageURL: String
    let variants: [WISSVariant]
}
struct WISSProposal: Decodable {
    let subjectId: String
    let frameId: String
    let name: String
    let kind: String
}
struct WISSPhoto: Decodable, Identifiable {
    let id: String
    let imageURL: String
    let decision: String
    let capturedAt: String?
    let consentSubjectCount: Int?
    let answeredCount: Int?
    let agreedCount: Int?
    let ownShareConsent: Bool?
    let shareStatus: String?
    let eligibleForConsent: Bool?
}
struct WISSSharePolicy: Decodable {
    let enabled: Bool
    let text: String
    let version: String
}
struct WISSGuide: Decodable {
    let imageURL: String
    let referenceURL: String
    let revision: String
}
struct WISSTransform: Decodable {
    let x: Double
    let y: Double
    let scale: Double
    let opacity: Double
}
struct WISSSession: Decodable {
    let guide: WISSGuide?
    let transform: WISSTransform?

    let id: String
    let joinCode: String
    let version: Int
    let subjects: [WISSSubject]
    let hostId: String?
    let representativeId: String?
    let activeFrameId: String?
    let mode: String
    let closed: Bool
    let reference: WISSReference?
    let proposals: [WISSProposal]
    let photos: [WISSPhoto]
    let sharePolicy: WISSSharePolicy?
}
struct WISSInvitations: Decodable {
    let joinCode: String
    let photographerCode: String
    let joinQR: String
    let photographerQR: String
}
private struct WISSSocketState: Decodable { let type: String; let session: WISSSession }

@MainActor
final class WISSModel: ObservableObject {
    @Published var invitations: WISSInvitations?
    @Published var credentials: WISSCredentials?
    @Published var session: WISSSession?
    @Published var library: [WISSReference] = []
    @Published var image: UIImage?
    @Published var error = ""
    @Published var connected = false
    @Published var busy = false
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var polling: Task<Void, Never>?
    private var active = false
    private let keychainAccount = "wiss-production-single-session"
    var isHost: Bool { credentials != nil && session?.hostId == credentials?.subjectId }
    var isRepresentative: Bool { credentials?.subjectId == session?.representativeId && credentials != nil }

    init() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "photo2026",
            kSecAttrAccount as String: keychainAccount, kSecReturnData as String: true]
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data { credentials = try? JSONDecoder().decode(WISSCredentials.self, from: data) }
    }
    func url(_ path: String, authenticated: Bool = false) -> URL {
        var components = URLComponents(url: APIConfig.appBaseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        components.query = nil
        if authenticated, let credentials { components.queryItems = [URLQueryItem(name: "token", value: credentials.token)] }
        return components.url!
    }
    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        var request = URLRequest(url: url("/api/wiss" + path))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let credentials { request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["error"] ?? "通信に失敗しました"
            throw NSError(domain: "WISS", code: (response as? HTTPURLResponse)?.statusCode ?? 0, userInfo: [NSLocalizedDescriptionKey: message])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func create() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let c: WISSCredentials = try await request("/sessions", method: "POST", body: [:])
            credentials = c; error = ""; persist(); await start()
        } catch { self.error = error.localizedDescription }
    }
    func loadInvitations() async {
        guard isHost, let credentials else { return }
        do { invitations = try await request("/sessions/\(credentials.sessionId)/invitations") }
        catch { self.error = error.localizedDescription }
    }
    func join(code: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let c: WISSCredentials = try await request("/join", method: "POST", body: ["joinCode": code.trimmingCharacters(in: .whitespacesAndNewlines)])
            credentials = c; error = ""; persist(); await start()
        } catch { self.error = error.localizedDescription }
    }
    private func persist() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "photo2026", kSecAttrAccount as String: keychainAccount]
        if let credentials, let data = try? JSONEncoder().encode(credentials) {
            let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if update == errSecSuccess { return }
            guard update == errSecItemNotFound else {
                error = "参加情報を端末に保存できません（\(update)）。アプリを閉じる前に運営者へお知らせください。"
                return
            }
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(item as CFDictionary, nil)
            if status != errSecSuccess { error = "参加情報を端末に保存できません（\(status)）。アプリを閉じる前に運営者へお知らせください。" }
        } else { SecItemDelete(query as CFDictionary) }
    }
    func start() async {
        guard credentials != nil else { return }
        active = true
        await refresh()
        guard active, credentials != nil, session?.closed != true else { return }
        if socket == nil { connect() }
        if polling == nil {
            polling = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(4))
                    guard !Task.isCancelled else { return }
                    await self?.refresh()
                }
            }
        }
    }
    func stop() { active = false; receiver?.cancel(); receiver = nil; polling?.cancel(); polling = nil; socket?.cancel(with: .goingAway, reason: nil); socket = nil; connected = false; image = nil }
    func reset() { stop(); credentials = nil; session = nil; invitations = nil; error = ""; persist() }
    func refresh() async {
        guard let credentials else { return }
        do {
            let result: WISSSession = try await request("/sessions/\(credentials.sessionId)")
            apply(result)
        }
        catch { self.error = error.localizedDescription }
    }
    private func apply(_ result: WISSSession) {
        guard result.id == credentials?.sessionId else { return }
        if let session, session.id == result.id {
            guard result.version >= session.version, !session.closed || result.closed else { return }
        }
        session = result
        if result.closed { stop() }
    }
    func loadLibrary() async {
        do { library = try await request("/library") } catch { self.error = error.localizedDescription }
    }
    func perform(_ action: String, body: [String: Any]) async {
        guard let credentials, !busy else { return }; busy = true; defer { busy = false }
        do {
            let result: WISSSession = try await request("/sessions/\(credentials.sessionId)/\(action)", method: action == "active-frame" ? "PUT" : "POST", body: body)
            apply(result); error = ""
        } catch { self.error = error.localizedDescription; await refresh() }
    }
    func activate(_ frameId: String?) async {
        await perform("active-frame", body: ["frameId": frameId as Any? ?? NSNull(), "expectedVersion": session?.version ?? -1])
    }
    func respondShare(photoId: String, share: Bool) async {
        guard let credentials, !busy else { return }; busy = true; defer { busy = false }
        do {
            let result: WISSSession = try await request("/sessions/\(credentials.sessionId)/photos/\(photoId)/share-consent", method: "POST", body: ["share": share, "statementVersion": session?.sharePolicy?.version ?? ""])
            apply(result); error = ""
        } catch { self.error = error.localizedDescription; await refresh() }
    }
    func createGuide(data: Data, kind: String) async {
        guard let credentials, !busy else { return }; busy = true; defer { busy = false }
        do {
            let boundary = UUID().uuidString
            var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\n\(kind)\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"reference\"; filename=\"reference.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8)
            body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            var request = URLRequest(url: url("/api/wiss/sessions/\(credentials.sessionId)/guide"))
            request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 140
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
            let (bytes, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw NSError(domain: "WISS", code: 1, userInfo: [NSLocalizedDescriptionKey: "ガイドを生成できません。写真やサーバー設定を確認してください"]) }
            apply(try JSONDecoder().decode(WISSSession.self, from: bytes)); error = ""
        } catch { self.error = error.localizedDescription }
    }
    func transform(x: Double, y: Double, scale: Double, opacity: Double) async {
        guard let credentials else { return }
        do {
            let result: WISSSession = try await request("/sessions/\(credentials.sessionId)/guide-transform", method: "PUT", body: ["x": x, "y": y, "scale": scale, "opacity": opacity])
            apply(result)
        } catch { self.error = error.localizedDescription }
    }
    func deletePhoto(_ photo: WISSPhoto) async {
        guard let credentials, !busy else { return }; busy = true; defer { busy = false }
        do {
            let _: WISSPhoto = try await request("/sessions/\(credentials.sessionId)/photos/\(photo.id)/decision", method: "POST", body: ["decision": "deleted"])
            await refresh(); error = ""
        } catch { self.error = error.localizedDescription }
    }
    func savePhotoToDevice(_ photo: WISSPhoto) async {
        guard let credentials else { return }
        do {
            let access = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
            guard access == .authorized || access == .limited else { throw NSError(domain: "WISS", code: 1, userInfo: [NSLocalizedDescriptionKey: "写真ライブラリへの追加を許可してください"]) }
            var request = URLRequest(url: url(photo.imageURL))
            request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), let image = UIImage(data: data) else {
                throw NSError(domain: "WISS", code: 2, userInfo: [NSLocalizedDescriptionKey: "写真を取得できません"])
            }
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }
            error = "端末の写真ライブラリへ保存しました"
        } catch { self.error = error.localizedDescription }
    }
    private func connect() {
        guard active, let credentials else { return }
        var components = URLComponents(url: url("/ws/wiss"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "sessionId", value: credentials.sessionId), URLQueryItem(name: "token", value: credentials.token)]
        let task = URLSession.shared.webSocketTask(with: components.url!)
        socket = task; task.resume()
        receiver = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard let self, self.socket === task else { return }
                    self.connected = true
                    switch message {
                    case .data(let data): self.image = UIImage(data: data)
                    case .string(let text):
                        if let payload = try? JSONDecoder().decode(WISSSocketState.self, from: Data(text.utf8)) { self.apply(payload.session) }
                    @unknown default: break
                    }
                } catch {
                    guard let self, self.socket === task else { return }
                    self.connected = false; self.image = nil; self.socket = nil
                    guard self.active, self.session?.closed != true else { return }
                    if task.closeCode.rawValue == 4000 { self.error = "別の端末で接続されました"; return }
                    try? await Task.sleep(for: .seconds(2))
                    if !Task.isCancelled { self.connect() }
                    return
                }
            }
        }
    }
}
