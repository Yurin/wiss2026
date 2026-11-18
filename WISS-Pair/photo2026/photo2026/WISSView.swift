import SwiftUI
import PhotosUI

struct WISSView: View {
    @StateObject private var model = WISSModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var guidePhoto: PhotosPickerItem?
    @State private var guideData: Data?
    @State private var croppingGuide = false
    @State private var cropRect = CropRect.centered
    @State private var guideKind = "rectangle"
    @State private var guideX = 0.0
    @State private var guideY = 0.0
    @State private var guideScale = 1.0
    @State private var guideOpacity = 0.65
    @State private var showGuide = false
    @State private var showInvitations = false
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
                            Text(session.guide != nil && (session.transform?.opacity ?? 0) > 0 ? "ガイド撮影" : "自由撮影 / ガイドなし").font(.headline)
                            Spacer()
                            Text("\(session.subjects.count)/1人 · \(model.isRepresentative ? "代表者" : "被写体") · \(model.connected ? "接続中" : "再接続中")").font(.caption)
                        }
                        HStack(spacing: 12) {
                            VStack(spacing: 4) {
                                Text("お手本写真").font(.caption)
                                picture {
                                    if let guide = session.guide { remoteImage(guide.referenceURL, authenticated: true).id(guide.revision) }
                                    else if let ref = session.reference { remoteImage(ref.imageURL) }
                                    else { Text("自由にポーズを取ってください").foregroundStyle(.white) }
                                }
                            }
                            VStack(spacing: 4) {
                                Text("撮影者の映像 ＋ フレーム").font(.caption)
                                picture {
                                    if let image = model.image { Image(uiImage: image).resizable().scaledToFit() }
                                    else { Text("映像を待っています").foregroundStyle(.white) }
                                    if let guide = session.guide {
                                        GeometryReader { geo in
                                            remoteImage(guide.imageURL, authenticated: true).id(guide.revision)
                                                .scaleEffect(session.transform?.scale ?? 1)
                                                .offset(x: geo.size.width * (session.transform?.x ?? 0), y: geo.size.height * (session.transform?.y ?? 0))
                                                .opacity(session.transform?.opacity ?? 0.65)
                                        }.clipped().allowsHitTesting(false)
                                    }
                                    if let v = session.reference?.variants.first(where: { $0.id == session.activeFrameId }) { remoteImage(v.imageURL).opacity(0.65).allowsHitTesting(false) }
                                }
                            }
                        }.frame(maxHeight: .infinity)
                        HStack {
                            if model.isHost {
                                Button("参加者を招待") { showInvitations = true }
                                Button("撮影を終了", role: .destructive) { confirmEnd = true }
                            }
                            Button("ガイドを作成・調整") { showGuide = true }
                            Button("撮影写真") { showPhotos = true }

                        }.buttonStyle(.bordered)
                    }.padding(.horizontal, 16)
                } else {
                    HStack(spacing: 24) {
                        VStack(spacing: 16) {
                            Text("WISS Pair").font(.title2.bold())
                            if model.credentials == nil {
                                Button("セッションを作成") { Task { await model.create() } }
                                    .buttonStyle(.borderedProminent).disabled(model.busy)
                            }
                            if model.credentials != nil {
                                Button("セッションに再接続") { Task { await model.start() } }.buttonStyle(.borderedProminent).disabled(model.busy)
                            }
                            if model.credentials != nil { Button("保存した参加情報をリセット") { model.reset() } }
                        }
                    }.padding()

                }
            }
            .safeAreaInset(edge: .bottom) { if !model.error.isEmpty { Text(model.error).font(.caption).foregroundStyle(.red).padding(4) } }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showInvitations) { invitationsView }
            .confirmationDialog("撮影を終了しますか？", isPresented: $confirmEnd, titleVisibility: .visible) {
                Button("全員のセッションを終了", role: .destructive) { Task { await model.perform("close", body: [:]) } }
            }
            .sheet(isPresented: $showPhotos) { photosView }
            .sheet(isPresented: $showGuide) { guideEditor
                .sheet(isPresented: $croppingGuide) {
                    if let data = guideData, let image = UIImage(data: data) {
                        CropEditorView(image: image, initialCrop: cropRect) { rect in
                            cropRect = rect
                            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 1200))
                            let cropped = renderer.image { _ in
                                image.draw(in: CGRect(x: -rect.x * 900 / rect.width, y: -rect.y * 1200 / rect.height, width: 900 / rect.width, height: 1200 / rect.height))
                            }
                            guideData = cropped.jpegData(compressionQuality: 0.95)
                            cropRect = .centered(for: cropped.size)
                            croppingGuide = false
                        }
                    }
                }
            }
            .onChange(of: guidePhoto) { _, item in
                Task { if let data = try? await item?.loadTransferable(type: Data.self), let image = UIImage(data: data) { guideData = image.jpegData(compressionQuality: 0.9); cropRect = .centered(for: image.size) } }
            }
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
                code = invitationCode
            }
        }
    }
    private var guideEditor: some View {
        NavigationStack {
            Form {
                PhotosPicker("参照写真を選択", selection: $guidePhoto, matching: .images)
                Text("参照写真を縦3:4に切り抜きます。必要に応じて範囲を調整してください。")
                Button("切り抜き範囲を調整") { croppingGuide = true }.disabled(guideData == nil)
                if let data = guideData, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 180) }
                Picker("ガイド種類", selection: $guideKind) {
                    Text("人物枠").tag("rectangle")
                    Text("人物枠＋主要ポイント").tag("keypoints")
                    Text("シルエット").tag("silhouette")
                }
                Button(model.busy ? "生成中…" : "ガイドを生成") { if let guideData { Task { await model.createGuide(data: guideData, kind: guideKind) } } }.disabled(model.busy || guideData == nil)
                Text("横位置"); Slider(value: $guideX, in: -1...1)
                Text("縦位置"); Slider(value: $guideY, in: -1...1)
                Text("大きさ"); Slider(value: $guideScale, in: 0.25...3)
                Text("濃さ（0で非表示）"); Slider(value: $guideOpacity, in: 0...1)
                Button("調整を反映") { Task { await model.transform(x: guideX, y: guideY, scale: guideScale, opacity: guideOpacity) } }
                Text(model.error).foregroundStyle(.red)
            }.navigationTitle("ガイド")
                .toolbar { Button("閉じる") { showGuide = false } }
                .onAppear { if let t = model.session?.transform { guideX = t.x; guideY = t.y; guideScale = t.scale; guideOpacity = t.opacity } }
        }
    }
    private var invitationsView: some View {
        NavigationStack {
            ScrollView {
                if let invitations = model.invitations {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 180))], spacing: 16) {
                        invitation("撮影者Web用", code: invitations.photographerCode, qr: invitations.photographerQR)
                    }.padding()
                    Text("親機を含め被写体は最大1人、撮影者は1台参加できます。")
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
        Color.black.overlay { ZStack { content() } }.aspectRatio(3 / 4, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 10))
    }
    private func remoteImage(_ path: String, authenticated: Bool = false) -> some View {
        AsyncImage(url: model.url(path, authenticated: authenticated)) { image in image.resizable().scaledToFit() } placeholder: { ProgressView() }
    }
    private var photosView: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 240))]) {
                    ForEach(model.session?.photos ?? []) { photo in
                        VStack(alignment: .leading, spacing: 10) {
                            remoteImage(photo.imageURL, authenticated: true).aspectRatio(3 / 4, contentMode: .fit)
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
