# rekordbox-mixlog

rekordboxでつなぎが決まった直後に撮った画面写真を Google フォトから選び、
「どの曲からどの曲へつないだか」を読み取って記録し、セットリストとして書き出す個人用アプリ。

```
GitHub Pages (index.html / app.js)
  ├─ Google ログイン（Google Identity Services）
  ├─ Google Photos Picker API … 写真を選ぶ（撮影日時 createTime も取得）
  ├─ Google Drive appDataFolder … 記録 mixlog.json を保存・端末間で同期
  └─ Cloudflare Worker
       ├─ /photo … 写真の中継（ブラウザから直接取れないため）
       └─ /read  … Claude API で曲名・BPM・キー・フェーダー位置を読み取り
                   （APIキーはWorkerのsecretにだけ置く）
```

判定ルール：チャンネルフェーダーが上がっているデッキ＝つないだ先（IN）、下がっているデッキ＝元の曲（OUT）。

---

## セットアップ

### 1. Google Cloud

1. https://console.cloud.google.com/ でプロジェクトを作る（例：`rekordbox-mixlog`）。
2. 「APIとサービス」→「ライブラリ」で次の2つを有効にする。
   - **Photos Picker API**
   - **Google Drive API**
3. 「OAuth 同意画面」（Google Auth Platform）
   - ユーザーの種類：外部
   - 公開ステータス：テスト中のままでよい
   - テストユーザーに自分のGoogleアカウントを追加
   - スコープ（データアクセス）に次を追加
     - `.../auth/photospicker.mediaitems.readonly`
     - `.../auth/drive.appdata`
     - `openid`、`.../auth/userinfo.email`
4. 「認証情報」→「OAuth クライアント ID を作成」
   - 種類：ウェブ アプリケーション
   - 承認済みの JavaScript 生成元：`https://gateofzen.github.io`
     （手元で試すなら `http://localhost:8000` も）
   - リダイレクトURIは不要
5. 表示された **クライアントID** を控える。

### 2. Cloudflare Worker

```bash
cd worker
# wrangler.toml の GOOGLE_CLIENT_ID / ALLOWED_EMAILS / ALLOWED_ORIGIN を書き換える
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY   # Anthropic Console で作ったキーを貼る
npx wrangler deploy
```

表示されたURL（`https://rekordbox-mixlog.<あなたのサブドメイン>.workers.dev`）を控える。

Workerは次をすべて満たす呼び出しだけを受け付ける。
- `Origin` が `ALLOWED_ORIGIN`
- Googleのアクセストークンが自分のOAuthクライアントのもので、メールアドレスが `ALLOWED_EMAILS` に含まれる
- 写真URLが `*.googleusercontent.com`

そのため、URLが知られてもAPIキーの利用枠を他人に使われることはない。

### 3. アプリ（GitHub Pages）

1. `config.js` の `GOOGLE_CLIENT_ID` と `WORKER_URL` を書き換える。
2. `index.html` `app.js` `style.css` `config.js` をリポジトリ `gateofzen/rekordbox-mixlog` のルートに置く。
   （`worker/` フォルダは同じリポジトリに入れてよい。Pagesからは使わない）
3. Settings → Pages → Branch: `main` / `(root)` で公開。
4. `https://gateofzen.github.io/rekordbox-mixlog/` を開いてログイン。

### 4. claude.ai版 Mix Log からの移行

claude.ai版で「記録」の **JSON** を書き出し、こちらの「JSONを読み込む」で取り込む。
同じ時刻・同じ曲の組み合わせは重複して取り込まない。

---

## 使い方

1. 「Google フォトから選ぶ」→ 新しいタブで写真を複数選んで「完了」。タブは自動で閉じる。
2. 1枚ずつ読み取り結果が出る。曲名の修正や「順番を入れ替える」で直してから「記録する」。
   まとめてよければ「読み取り済みをすべて記録」。
3. 「セットリスト」に、その時間帯の曲順ができる。テキストは1曲1行で `曲名 / アーティスト名 (アルバム名) [BPM]`。CSV・JSONでも書き出せる。

- アルバム名は画面下のトラックリストに該当曲の行が見えているときだけ読み取れる。見えていなければ空欄なので、必要なら手で入れる。

- 撮影時刻は Google フォトの撮影日時（`createTime`）を使う。端末の写真を直接選んだときは EXIF → ファイル名 → 更新日時の順。
- 一度記録した Google フォトの写真は、次に選んでも飛ばす。
- セットは撮影間隔が60分以上あいたところで区切る。開始・終了を手で指定することもできる。

## インストール（PWA）

- PC（Chrome / Edge）：画面右上の「アプリとしてインストール」か、アドレスバー右端のインストールアイコン。
- Android（Chrome）：「アプリとしてインストール」か、メニュー →「ホーム画面に追加」→「インストール」。

## 費用の目安

読み取り1枚ごとにClaude APIを1回呼ぶ（画像1枚＋短いJSON応答）。
モデルは `wrangler.toml` の `MODEL` で変えられる。

## 制約

- Picker APIで取得した写真URLの有効期限は60分。選んでから時間がたって読み取りに失敗したら選び直す。
- アクセストークンは1時間で切れる。切れたら「ログイン」を押し直す。
- OAuth同意画面が「テスト中」のあいだ、使えるのはテストユーザーに追加したアカウントだけ。
