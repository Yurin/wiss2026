# WISS Challenge 2026 当日版

1対1（縦3:4）と1対N（横4:3、被写体最大6人）の協調撮影。端末への保存と公式Immich共有は別操作です。このリポジトリには当日版のみを収録しています。研究版の参照元は含みません。

## 起動

Node.js 22以上。新しいサーバーでは以下の手順でcloneします。すでにclone済みの場合は、そのリポジトリのルートで `npm ci` 以降を実行してください。

```sh
git clone https://github.com/Yurin/wiss2026.git
cd wiss2026
npm ci
cp WISS-Pair/backend/.env.example WISS-Pair/backend/.env
cp WISS-Together/backend/.env.example WISS-Together/backend/.env
npm run start:pair
# 別ターミナル
npm run start:together
```

既定の待受は `127.0.0.1:3101` と `127.0.0.1:3102`。撮影者画面は `/booth/`、運営画面は `/admin/`、稼働確認は `/health` です。カメラとiOS接続には、運用時は各バックエンドにHTTPSの別ホスト名を割り当ててください。WebSocket `/ws/wiss` も同じホストへ転送します。

`.env` の `WISS_PUBLIC_URL`、`WISS_OPERATOR_TOKEN`、`WISS_WORKER_TOKEN` を設定します。秘密情報は空のテンプレートのみ同梱。共有は既定で無効・保留です。ImmichのAPI URL・APIキー・アルバムIDが未確定でも撮影と端末保存は利用できます。共有同意文を設定すると共有予約を受け付けられます。

## 1対1のガイド生成

```sh
python3 -m venv WISS-Pair/backend/.venv
WISS-Pair/backend/.venv/bin/pip install -r WISS-Pair/backend/guide_processor/requirements.txt
```

1対1の `.env` の `WISS_PYTHON` に、この仮想環境のPythonの**絶対パス**を指定します。既存ガイド生成を使用し、人物枠・人物枠＋主要ポイント・シルエットを生成します。使用モデルは `WISS-Pair/backend/` の `yolov8n.pt`、`yolov8n-pose.pt`、`yolo11s-seg.pt` のみ。Ultralytics由来のモデル・ライブラリの帰属と配布条件を引き継ぎます（https://github.com/ultralytics/ultralytics）。任意のSAMモデルが未配置の場合はSAM再処理を行いません。ガイド生成が失敗しても撮影は利用できます。

## iOS

各 `WISS-*/photo2026/photo2026.xcodeproj` をXcodeで開き、署名チームと端末を指定してビルドします。アプリ名は 1対1が `WISS Pair`、1対Nが `WISS Together`。Bundle ID・URLスキーム・Keychain・サーバー保存キーは研究版と分離しています。

iOS設定アプリの各アプリ内「サーバーURL」に対応するHTTPSバックエンドのルートURLを設定し、再起動します。既定値は未設定を示す `configure-server.invalid` です。研究サーバーへ自動接続しません。

## 参加者の操作

1. 被写体iOSでセッションを作成。Pairは撮影者コードで参加。Togetherはアプリが共通QRを表示し、他のスマートフォンはアプリなしでQRを読み取り、撮影者または被写体を選んでブラウザ参加。作成したアプリ端末は必ず被写体になります。
2. 1対1は参照写真を選び、縦3:4の切り抜き範囲とガイド種類を指定。位置・倍率・濃さを調整。1対Nは参加者を共通QRで招待し、事前フレームを提案・代表者が確定。フレームなしでも撮影可能。
3. ブラウザでカメラ開始→撮影→確認。撮り直す場合は削除して再撮影。「写真を確定・被写体へ渡す」で一時保存を確定。
4. iOSまたは被写体ブラウザの「撮影写真」で確認し「端末に保存」。撮影者ブラウザでも写真をダウンロードできます。
5. 写真ごとの説明を読み「WISS公式アルバムに共有する」または「共有しない」。1対Nは撮影時の被写体全員の同意で共有予約。未回答・不同意は次の撮影を妨げません。
6. 写真画面で共有状態を確認。終了後も資格を残していれば写真確認・同意・状態更新が可能。次の参加者へ端末を渡す前に写真を保存し、参加画面へ戻って資格をリセット。

詳細は [確定仕様](docs/production-spec.md) と [運用手順](docs/operations.md)。旧資料の `docs/archive/` はローカル参照用で、Gitには含めません。

Togetherのセッション作成には、運営がバックエンド `.env` の `WISS_APP_CREATOR_TOKEN` と、iOS設定アプリ内の「作成用資格」に同じランダムな資格を設定します。この資格はQR・公開Web画面へ渡しません。未設定でもQRから既存セッションへ参加できますが、新規作成はできません。

## Gitとサーバー更新

実際の `.env`、写真、保存データ、node_modules、Python仮想環境、旧研究資料はGit対象外です。必要なモデル3つは収録しています。サーバーでは非公開データの `WISS_DATA_DIR` をclone先の外に設定し、各バックエンドを1プロセスずつ常駐管理してください。更新時は共有送信を一時停止し、実行中処理が終了してから `git pull --ff-only` と `npm ci` を行い、サービスを再起動・確認して送信を再開します。詳細は運用手順を参照してください。
