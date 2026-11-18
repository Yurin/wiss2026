import SwiftUI

struct WISSView: View {
    @StateObject private var model = WISSModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var showInvitations = false
    @State private var showJoin = false
    @State private var confirmEnd = false
    @State private var code = ""
    @State private var showLibrary = false
    @State private var showPhotos = false
    @State private var photoToDelete: WISSPhoto?
    @State private var selectedReference: WISSReference?
    @State private var selectedVariant: WISSVariant?

    var body: some View {
        NavigationStack {
            Group {
                if model.session?.closed == true {
                    finishedView
                } else if let session = model.session {
                    VStack(spacing: 8) {
                        HStack {
                            Text(session.reference?.name ?? "自由撮影 / フレームなし").font(.headline)
                            Spacer()
                            Text("\(session.subjects.count)/6人 · \(model.isRepresentative ? "代表者" : "被写体") · \(model.connected ? "接続中" : "再接続中")").font(.caption)
                        }
                        HStack(spacing: 12) {
                            VStack(spacing: 4) {
                                Text("お手本写真").font(.caption)
                                picture {
                                    if let ref = session.reference { remoteImage(ref.imageURL) }
                                    else { Text("自由にポーズを取ってください").foregroundStyle(.white) }
                                }
                            }
                            VStack(spacing: 4) {
                                Text("撮影者の映像 ＋ フレーム").font(.caption)
                                picture {
                                    if let image = model.image { Image(uiImage: image).resizable().scaledToFit() }
                                    else { Text("映像を待っています").foregroundStyle(.white) }
                                    if let v = session.reference?.variants.first(where: { $0.id == session.activeFrameId }) { remoteImage(v.imageURL).opacity(0.65).allowsHitTesting(false) }
                                }
                            }
                        }.frame(maxHeight: .infinity)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140))], spacing: 8) {
                            if model.isHost {
                                Button("参加者を招待") { showInvitations = true }
                                Button("撮影を終了", role: .destructive) { confirmEnd = true }
                            }
                            Button("フレームを選択・提案") { showLibrary = true }
                            Button("撮影写真") { showPhotos = true }
                            if model.isRepresentative { Button("自由撮影") { Task { await model.activate(nil) } } }
                        }.buttonStyle(.bordered)
                    }.padding(.horizontal, 16)
                } else {
                    VStack(spacing: 16) {
                        Text("WISS Together").font(.title2.bold())
                        if model.credentials == nil {
                            Button("セッションを作成") { Task { await model.create() } }
                                .buttonStyle(.borderedProminent).disabled(model.busy)
                            Button("グループに参加") { showJoin = true }
                                .buttonStyle(.bordered).disabled(model.busy)
                        } else {
                            Button("セッションに再接続") { Task { await model.start() } }
                                .buttonStyle(.borderedProminent).disabled(model.busy)
                            Button("保存した参加情報をリセット") { model.reset() }
                        }
                    }.padding()

                }
            }
            .safeAreaInset(edge: .bottom) { if !model.error.isEmpty { Text(model.error).font(.caption).foregroundStyle(.red).padding(4) } }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showInvitations) { invitationsView }
            .sheet(isPresented: $showJoin) { joinView }
            .onChange(of: model.credentials?.sessionId) { _, id in if id != nil { showJoin = false } }
            .confirmationDialog("撮影を終了しますか？", isPresented: $confirmEnd, titleVisibility: .visible) {
                Button("全員のセッションを終了", role: .destructive) { Task { await model.perform("close", body: [:]) } }
            }
            .sheet(isPresented: $showLibrary) { libraryView }
            .sheet(isPresented: $showPhotos) { photosView }
            .task { await model.start() }
            .onChange(of: model.session?.closed) { _, closed in
                if closed == true {
                    showInvitations = false; showLibrary = false; showPhotos = false
                    selectedReference = nil; selectedVariant = nil
                }
            }
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.start() } } else { model.stop() } }
            .onOpenURL { url in
                guard model.credentials == nil, let invitationCode = WISSInvitation.code(from: url.absoluteString) else { return }
                code = invitationCode; showJoin = true
            }
        }
    }
    private var joinView: some View {
        NavigationStack {
            Form {
                Section("QRコードで参加") {
                    WISSQRScanner { code = $0 }
                        .frame(height: 220)
                }
                Section("参加コード") {
                    TextField("参加コード", text: $code)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .accessibilityIdentifier("wissJoinCode")
                    Button("撮影に参加") { Task { await model.join(code: code) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Text("セッションを作成した人の招待画面で、QRコードまたは参加コードを確認してください。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !model.error.isEmpty { Text(model.error).foregroundStyle(.red) }
            }.navigationTitle("グループに参加")
                .toolbar { Button("閉じる") { showJoin = false } }
        }
    }
    private var invitationsView: some View {
        NavigationStack {
            ScrollView {
                if let invitations = model.invitations {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 180))], spacing: 16) {
                        invitation("ブラウザ参加用", code: invitations.joinCode, qr: invitations.joinQR)
                    }.padding()
                    Text("このアプリ端末は被写体です。他のスマートフォンでQRを読み取ると、アプリなしで撮影者・被写体を選んで参加できます。被写体はこの端末を含め最大6人、撮影者は1人です。")
                } else { ProgressView() }
                if !model.error.isEmpty { Text(model.error).foregroundStyle(.red) }
            }.navigationTitle("参加者を招待")
                .toolbar { Button("閉じる") { showInvitations = false } }
                .task { await model.loadInvitations() }
        }
    }
    private func invitation(_ title: String, code: String, qr: String) -> some View {
        VStack {
            Text(title).font(.headline)
            if let encoded = qr.split(separator: ",").last,
               let data = Data(base64Encoded: String(encoded)), let image = UIImage(data: data) {
                Image(uiImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 180, height: 180)
            }
            Text(code).font(.title3.monospaced()).textSelection(.enabled)
        }
    }
    private var finishedView: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 48)).foregroundStyle(.green)
            Text("撮影が終了しました").font(.title.bold()).accessibilityIdentifier("wissSessionFinished")
            Text("ご参加ありがとうございました。撮影した写真を確認できます。")
                .foregroundStyle(.secondary)
            Button("撮影写真を見る") { showPhotos = true }.buttonStyle(.borderedProminent)
            Button("参加画面に戻る") { code = ""; model.reset() }.buttonStyle(.bordered)
        }.padding()
    }
    private func picture<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        Color.black.overlay { ZStack { content() } }.aspectRatio(4 / 3, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 10))
    }
    private func remoteImage(_ path: String, authenticated: Bool = false) -> some View {
        AsyncImage(url: model.url(path, authenticated: authenticated)) { image in image.resizable().scaledToFit() } placeholder: { ProgressView() }
    }
    private var libraryView: some View {
        NavigationStack {
            Form {
                if let session = model.session, !session.proposals.isEmpty {
                    Section("グループからの提案") {
                        ForEach(session.proposals, id: \.subjectId) { proposal in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(proposal.name)
                                if model.isRepresentative {
                                    Button("この提案を確定") { Task { await model.activate(proposal.frameId); if model.error.isEmpty { showLibrary = false } } }
                                        .disabled(model.busy)
                                }
                            }
                        }
                    }
                }
                Section("参照写真を選択") {
                    if model.library.isEmpty {
                        Text("公開済みフレームはまだありません。自由撮影をご利用ください。")
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 140))], spacing: 12) {
                        ForEach(model.library) { reference in
                            Button { selectedReference = reference; selectedVariant = nil } label: {
                                VStack(spacing: 6) {
                                    remoteImage(reference.imageURL).aspectRatio(4 / 3, contentMode: .fit)
                                    Text("\(reference.name) · \(reference.subjectCount)人")
                                    if selectedReference?.id == reference.id { Image(systemName: "checkmark.circle.fill") }
                                }
                            }.buttonStyle(.plain)
                        }
                    }
                }
                if let reference = selectedReference {
                    Section("フレーム種類") {
                        ForEach(reference.variants) { variant in
                            Button {
                                selectedVariant = variant
                                Task { await model.perform("view", body: ["frameId": variant.id]) }
                            } label: {
                                HStack {
                                    Text(variant.title)
                                    Spacer()
                                    if selectedVariant?.id == variant.id { Image(systemName: "checkmark") }
                                }
                            }.disabled(model.busy)
                        }
                        if let variant = selectedVariant {
                            picture { remoteImage(reference.imageURL); remoteImage(variant.imageURL).opacity(0.65) }
                            Button("グループに提案") { Task { await model.perform("proposals", body: ["frameId": variant.id]) } }
                                .buttonStyle(.bordered).disabled(model.busy)
                            if model.isRepresentative {
                                Button("撮影フレームに確定") { Task { await model.activate(variant.id); if model.error.isEmpty { showLibrary = false } } }
                                    .buttonStyle(.borderedProminent).disabled(model.busy)
                            }
                        }
                    }
                }
                Section("撮影設定") {
                    if model.isRepresentative {
                        Button("自由撮影にする") { Task { await model.activate(nil); if model.error.isEmpty { showLibrary = false } } }.disabled(model.busy)
                    }
                    if model.isRepresentative || model.isHost, let session = model.session {
                        Menu("代表者を変更") {
                            ForEach(Array(session.subjects.enumerated()), id: \.element.id) { index, subject in
                                Button("\(index + 1)人目") { Task { await model.perform("representative", body: ["subjectId": subject.id, "expectedVersion": session.version]) } }
                            }
                        }.disabled(model.busy)
                    }
                }
                if !model.error.isEmpty { Text(model.error).foregroundStyle(.red) }
            }.navigationTitle("フレーム")
                .toolbar { Button("閉じる") { showLibrary = false } }
                .task { await model.loadLibrary() }
        }
    }
    private var photosView: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 240))]) {
                    ForEach(model.session?.photos ?? []) { photo in
                        VStack(alignment: .leading, spacing: 10) {
                            remoteImage(photo.imageURL, authenticated: true).aspectRatio(4 / 3, contentMode: .fit)
                            Text(photo.decision == "saved" ? "写真を確認" : "撮影者が確認中")
                            if photo.decision == "saved" {
                                Button("端末に保存") { Task { await model.savePhotoToDevice(photo) } }.buttonStyle(.bordered)
                                if ["not-shared", "awaiting-consent"].contains(photo.shareStatus ?? "not-shared") { Button("一時保存から削除", role: .destructive) { photoToDelete = photo } }
                                if let session = model.session, let policy = session.sharePolicy, policy.enabled {
                                    Text(policy.text).font(.footnote).fixedSize(horizontal: false, vertical: true)
                                    if photo.ownShareConsent == nil && photo.eligibleForConsent == true {
                                        VStack(alignment: .leading) {
                                            Button("WISS公式アルバムに共有する") { Task { await model.respondShare(photoId: photo.id, share: true) } }.buttonStyle(.borderedProminent)
                                            Button("共有しない") { Task { await model.respondShare(photoId: photo.id, share: false) } }.buttonStyle(.bordered)
                                        }.disabled(model.busy)
                                        Text("この写真について、撮影時に参加していた全員の回答が「共有する」の場合だけ送信されます。回答しなくても撮影や次の撮影に影響しません。").font(.caption)
                                    } else {
                                        Text(photo.eligibleForConsent != true ? "撮影時の参加者が共有を選択します" : photo.ownShareConsent == true ? "あなたは共有に同意済み" : "あなたは共有しないと回答済み")
                                        Text(shareStatus(photo.shareStatus, photo: photo)).font(.caption)
                                    }
                                } else {
                                    Text("公式共有は未設定です。端末保存は引き続き利用できます。").font(.caption)
                                }
                            }
                        }.padding(8).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
                    }
                }.padding()
            }.confirmationDialog("全員の写真一覧から削除しますか？端末に保存済みの写真は残ります。", isPresented: Binding(get: { photoToDelete != nil }, set: { if !$0 { photoToDelete = nil } }), titleVisibility: .visible) {
                Button("写真を削除", role: .destructive) { if let photo = photoToDelete { Task { await model.deletePhoto(photo) } }; photoToDelete = nil }
            }.navigationTitle("撮影写真").toolbar { Button("更新") { Task { await model.refresh() } }; Button("閉じる") { showPhotos = false } }
        }
    }
    private func shareStatus(_ status: String?, photo: WISSPhoto) -> String {
        switch status {
        case "awaiting-consent": return "共有の回答待ち：\(photo.answeredCount ?? 0)/\(photo.consentSubjectCount ?? 0)人"
        case "queued": return "公式共有を予約しました"
        case "uploading": return "公式アルバムへ写真を送信中"
        case "album-adding": return "公式アルバムへ登録中"
        case "complete": return "WISS公式アルバムへの共有完了"
        case "retry": return "通信を待って再試行します"
        case "uncertain": return "送信結果を確認しています。未共有とは限りません"
        case "attention": return "運営が共有状況を確認しています"
        case "not-shared": return "この写真は公式共有されません"
        default: return "共有状況を確認中"
        }
    }
}

final class WISSAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        .portrait
    }
}
