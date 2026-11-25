# WISS Pair

`yuriverse/wiss2026/syuron_test/2026Collaboratry_Photographer_Interface` の通常撮影機能を基にした1対1アプリです。元のホーム、シーン別テンプレート、ガイド作成、ライブラリ、写真一覧、QRでの撮影者参加、ライブ映像、ガイドの位置・倍率・透過度調整、写真解析と撮り直し支援を維持します。

ユーザ実験開始・再開、実験者設定、条件割当、計画・試行管理、参加者の評価・アンケート、研究ログと研究用Exportは含みません。解析結果は撮影支援に必要な状態として保持します。

## iPhone

`photo2026/photo2026.xcodeproj` を開き、実機へRunしてください。Bundle IDは `com.yurinisocha.wiss2026prod.single`、表示名は `WISS Pair` のままです。

既定のサーバーURLは **https://photo-interface.com:8443**。変更する場合はiPhoneの「設定 → アプリ → WISS Pair → サーバーURL」で指定し、アプリを終了して開き直します。QRとWebSocketも同じ接続先を使用します。

## サーバー

リポジトリルートでNode.js 22以上を使います。

```sh
npm ci
# 既存 .env がない場合のみ作成
[ -f WISS-Pair/backend/.env ] || cp WISS-Pair/backend/.env.example WISS-Pair/backend/.env
python3 -m venv WISS-Pair/backend/.venv
WISS-Pair/backend/.venv/bin/pip install -r WISS-Pair/backend/guide_processor/requirements.txt
```

`.env` の `WISS_PYTHON` に仮想環境のPythonの絶対パス、`WISS_DATA_DIR` にリポジトリ外の専用保存先を設定してください。3101番ポートで起動し、Nginxの8443から転送します。既存サービスが動いている場合は二重起動しません。

```sh
npm run start:pair
# PM2で既に管理しているサーバーの更新時はこちら
pm2 restart wiss-pair-2026 --update-env
curl --fail https://photo-interface.com:8443/health
```

撮影者画面はルート `/?sessionId=...`、APIは `/api/session/...`、`/api/sessions/...`、`/api/photos`、映像は `/ws/video`、通知は `/ws/session` です。既存Nginxのルート全体のプロキシとWebSocket設定で転送できます。

写真は `WISS_DATA_DIR/uploads`、保存ガイドの参照情報は `WISS_DATA_DIR/reference_guides` に置きます。旧当日版のデータは削除・移行せず、別形式として残します。通常撮影のセッション保存期間は既定6時間です。写真は端末保存してください。

旧当日版の `/api/wiss` とは互換性がないため、**PairのバックエンドとiOSアプリはセットで更新**してください。Togetherには変更しません。復元元と同じくQRのセッションIDを知る人がその撮影へ参加できる方式です。公式Immichへの共有と旧当日版の運営画面はこのPair版には含みません。

## 検証

```sh
WISS_PYTHON=/absolute/path/to/python npm run test:pair
WISS-Pair/backend/.venv/bin/python -m unittest discover -s WISS-Pair/backend/guide_processor -p 'test_*.py'
xcodebuild -project WISS-Pair/photo2026/photo2026.xcodeproj -scheme photo2026 -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

通信テストは一時ポート・一時保存先を使い、終了時に停止・削除します。実機2台のカメラ・QR・写真保存・解析結果の見え方は別途確認が必要です。
