# Structure Dump

Figma の構造をまるごと書き出すプラグイン。特定の UI ライブラリには依存しない。
選択範囲をセクション単位・画面フレーム単位に分け、画面ごとの構造 JSON とスクリーンショットを
1 つの ZIP で書き出す。AI (Claude Code 等) に渡してコーディングさせるための入力を作る。
コード生成はしない。解釈とコード化は AI 側の仕事。

`shared/nodeOrder.ts` (走査順の固定) と `src/zip.ts` (無圧縮 ZIP) は兄弟プラグインの
[Component Spec](../component-spec/) と共有している。

## セットアップ

```sh
npm install        # リポルートで (未実施なら)
npm run build:dump
```

Figma への取り込みは[リポルート README の共通手順](../../README.md#figma-への取り込み-共通手順)を参照
(選択する manifest は `plugins/structure-dump/manifest.json`)。

## 使い方

1. 書き出したいセクションやフレームを選択する (未選択なら現在ページ直下の全ノードが対象)
2. プラグイン「Structure Dump」のメニューから「書き出し (スクリーンショット 2x)」を実行する
   (容量を抑えたいときは「書き出し (スクリーンショット 1x)」)
3. 「ZIPをダウンロード」で保存し、展開した中身をコーディング対象のリポジトリの専用フォルダ
   (例: `design-dump/`) に置く。ZIP 直下に `README.md` があるので、リポのルートへ直接展開すると
   既存の `README.md` と衝突する
4. AI には展開したフォルダを渡し、まずその中の `README.md` を読ませる

## ZIP の中身 (schema: dump-v3)

```
README.md                            読み方 (index.json と各 json のルール)
index.json                           セクション → 画面フレームの一覧 (id・名前・型・コンポーネント名・サイズ・座標)
<セクション>/<フレーム名>.<id>.png    画面フレームのスクリーンショット (既定 2x。1x も選べる)
<セクション>/<フレーム名>.<id>.json   その画面フレーム以下の構造
<セクション>/_section.json           画面フレームでもセクションでもない子の構造
<フレーム名>.<id>.png / .json         直接選んだノード・ページ直下のノード (ZIP 直下)
variables.json                       ファイル全体の Variables (コレクション・モード・全モードの値)
styles.json                          名前付きスタイルの中身
assets/<imageRef>.<拡張子>           image fill の元画像 (index.json の assets から引く)
assets/svg/<id>.svg                  ベクターだけのノード (アイコンなど) の SVG
```

- 何が画面フレームになるか、JSON の各キー、ノードの読み方は ZIP 内の `README.md` に書いてある。
  正本は [`src/zip-readme.md`](src/zip-readme.md) で、ビルド時に code.js へ埋め込まれる
  (esbuild の `--loader:.md=text`)

## 開発ループ (AI が自分で読み取る)

AI が Figma のデータを、クリックも Figma MCP の回数上限もなしに読み取るための仕組み。
プラグインを開いておくと、手元の dev サーバーへ来た依頼を書き出し、ZIP を展開した結果を AI が読む。
使えるのはリポジトリの manifest を取り込んだ開発プラグインだけ (配布する zip の manifest からは外してある)。

1. dev サーバーを起動する (リポルートで。止めるまで動き続ける)

   ```sh
   npm run dev:server                        # 結果は .dev-dump/ に置く
   npm run dev:server -- --out <ディレクトリ>  # 置き場所を変える
   ```

2. Figma でプラグインのメニューから「開発: dev サーバーとつなぐ」を実行し、開いたままにする (最初の 1 回だけ人か computer use の操作が要る)
3. 書き出しを依頼する。結果が届くまで待ってから、展開先 (`dir`) を含む JSON が返る

   ```sh
   curl -s -X POST localhost:47717/export -d '{"nodeIds":["9194:16583"]}'
   curl -s -X POST localhost:47717/export -d '{"nodeIds":["0:1"],"scale":1}'  # ページの id ならページ直下
   curl -s -X POST localhost:47717/export                                     # Figma で開いているページの選択
   ```

   - 結果は `<置き場所>/results/<version>/` に展開し、`<置き場所>/latest` がいちばん新しく成功した結果を指す。
     中身は「ZIP の中身」と同じで、まず `README.md` を読む。
     `version` は dev サーバーを起動し直しても前回の続きから振る。結果は新しいほうから 20 個残す。
   - 書き出せなかったとき (ノードが見つからない・すべて非表示など) は HTTP 422 で `error` に理由が入る。
   - プラグインが前の依頼を書き出しているあいだに来た依頼は、断らずに待たせ、前の依頼が終わってから順に書き出す。
     書き出し中のプラグインからは何も届かない (重いページでは Figma ごと固まる) が、渡した依頼の結果がまだ返っていなければ書き出し中と見る。
     Figma のウィンドウがほかのアプリの裏にあると、書き出しが大きく遅れ、止まったように見えることもある (前に出すと進む)。
   - 書き出し中の依頼が無く、プラグインから 35 秒何も届いていなければ、繋がっていないと見て、依頼を積まずにすぐ HTTP 503 を返す。
   - 300 秒以内に結果が来なければ HTTP 504 (`?timeout=<秒>` で変えられる)。
     Claude Code の Bash ツールは既定で 120 秒で切れるので、大きな書き出しでは Bash の timeout も延ばす。
   - 503 と 504 の本文には、プラグインの様子 (`plugin`) が入る。
     `plugin.processing` はプラグインへ渡してまだ結果が返っていない依頼 (`seq`・`nodeIds`・渡してからの秒数 `elapsedSeconds`) で、`plugin.lastSeenAt` は最後にプラグインから何か届いた時刻。
     504 でも `plugin.processing` があれば、プラグインは書き出し中で、時間切れになった依頼もあとで書き出す (`plugin.processing.seq` がその依頼なら書き出しの最中、前の依頼なら順番待ち)。
     送り直さずに、`GET /status` で今の `version` を取り、`GET /status?after=<version>` で次の結果を待つ。
     届いた結果の `seq` が自分の依頼でなければ (前の依頼の結果なら)、その `version` でもう一度待つ。
     `elapsedSeconds` が伸び続けるときは、Figma が前に出ているか、プラグインが開いているかを人か computer use で確かめる。
     504 で `plugin.processing` が無ければ、プラグインはその依頼を受け取っていない。プラグインが開いているか確かめてから送り直す。
   - `<置き場所>/status.json` と `GET /status` は、最後に受けた結果 (`version`・`seq`・`dir`・`fileName`・`warnings`・`error`) を返す。
     `GET /status` には `plugin` も入る。
     `GET /status?after=<version>` は、それより新しい結果が届くまで待つ (どの依頼の結果でも返る)。
     300 秒待っても届かなければ HTTP 504 で、待つ長さは `?timeout=<秒>` で変えられる。
4. プラグインのコードを直したら build する。ホットリロードでプラグインが走り直し、最後の依頼をもう一度書き出して送る

   ```sh
   npm run build:dump
   curl -s 'localhost:47717/status?after=<直前の version>'  # 走り直した結果が届くまで待つ
   ```

   Figma のメニュー「プラグインをホットリロード」が効いている必要がある。

プラグインの画面には、いつ・なぜ (新しい依頼か、起動より前に積まれていた依頼か) 書き出したかの記録が出る。

制約:

- 「開発: dev サーバーとつなぐ」は 1 つだけ開く。
  複数のファイルで開くと、どれも同じ依頼を書き出し、先に返したほうの結果が依頼側に返る (どのファイルの結果かは `fileName` で分かる)。
- ポートは 47717 で固定 (manifest の `devAllowedDomains` と同じ値)。dev サーバーは同時に 1 つしか動かせない。
- ホットリロードが走るのは、Figma が取り込んだ manifest のあるディレクトリで build したときだけ。
  別の worktree で build しても、取り込んだほうのプラグインは走り直さない。
- 走り直したプラグインが書き出すのは、最後の依頼 1 件だけ。それより前に積まれて応答していない依頼は、あとからも書き出さず、時間切れになる。
- 書き出しの途中でプラグインを閉じても、dev サーバーには分からない。
  その依頼は書き出し中のまま残り (`plugin.processing.elapsedSeconds` が伸び続ける)、次の依頼も待たせる。
  プラグインを開き直すと、最後の依頼 1 件を書き出し直す。
- dev サーバーは使うときだけ起動する。
  localhost でだけ待ち受け、localhost 以外の名前で来た送信と、AI 側の口 (`/export`・`/status`) への Origin 付きの送信 (ブラウザで開いたサイトからの送信) は断る。
  ただしプラグインの口は Figma のプラグインと同じ `Origin: null` を受けるので、ブラウザで開いたサイトの sandbox の iframe から結果を差し替えられる余地が残る。

## AI への渡し方のヒント

- 画面 1 枚ぶんの json + png をセットで渡すのが最も精度が出る
- 巨大なページ全体を一括で渡すより、セクション単位で選択して書き出す方がよい
- `props` と `componentName` を実装側コンポーネントへの対応表として先に AI に示すと安定する

## 未確認の前提 (Figma 実機での動作確認推奨)

開発側で実機未実測の項目。コード上は失敗時の分岐やフォールバックで扱っている。

- 巨大な選択 (数十 MB 級のスクリーンショット) での postMessage / メモリ挙動
- どの種類のノード (GROUP・インスタンス・ベクター等) でも `node.exportAsync` が成功すること
  (失敗は warning に落とし、index.json ではそのフレームを `png` 無しで載せて続行する設計)
- セクション直下のノードの `x` / `y` がセクションに対する相対座標であること
- SECTION とその子の `absoluteTransform` の平行移動成分が、ノードの原点のページ座標であること
  (`absoluteX` / `absoluteY` はここから取る)
- セクション内のノードを、そのセクションを選ばずに直接選んだときも ZIP 直下に置く挙動が
  使い勝手として妥当か
- 進捗表示 (`progress` メッセージ) が、書き出し中の UI に実際に反映されること
- メニューから実行したとき `figma.command` に manifest の `command` が入り、スクリーンショットの倍率が切り替わること
- `exportAsync` に `useAbsoluteBounds: true` を付けると、枠の外にはみ出した描画が切られ、png が枠 (`width` × `height` × 倍率) の大きさになること
- ライブラリ (remote) の変数とスタイルを variables.json / styles.json に足す処理
  (実機で試したファイルは、変数もスタイルもファイルの中のものだけだった)
- `annotations`・`hyperlink`・`textTruncation`・`variableModes` が実データで期待どおりに出ること

計画 (どのノードをどのパスへ出すか) と JSON 化、ZIP 生成、取得結果の振り分けのロジック自体は
`tests/structure-dump-*.test.mts` で検証済み (画面フレームの型の判定・ネストしたディレクトリ・
重複選択の除去・非表示ルートの除外・ファイル名の正規化・index.json の形と assets の対応表・
長いパスの検出・実物の ZIP リーダーと unzip CLI で開ける・壊れたバイト列が CRC で落ちる・
エントリ数の上限・剪定規則)。
