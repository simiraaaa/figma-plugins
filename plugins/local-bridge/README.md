# Local Bridge

AI が Figma のデータを、クリックも Figma MCP の回数上限もなしに読み書きするためのプラグイン。
Local Bridge を開いておくと、AI が curl で手元の dev サーバーへ送った依頼を Local Bridge が実行し、結果を AI が受け取る。
依頼は 2 種類ある。

- 書き出し: [Structure Dump](../structure-dump/) と同じ書き出しをして、ZIP を展開した結果を AI が読む。
  Local Bridge は Structure Dump の書き出し (`plugins/structure-dump/src/dump.ts`) を build で取り込むので、
  Structure Dump から書き出したものと同じ ZIP になる。
- script の実行: Plugin API のコードを渡して実行させる (「script の実行」)。

人が最初に読む文書は [利用ガイド](GUIDE.md) で、何ができるか・初めて使うときの準備・2 回目以降の使い方・困ったときの対処を書いてある。
このファイルには、dev サーバーと Local Bridge の仕様を書く。

リリースの zip には入れない。
使う人 (開発者もデザイナーも) は、リポジトリを clone して取り込む ([利用ガイド](GUIDE.md#初めて使うとき-1-回だけ))。
Structure Dump と Component Spec は通信しない。dev サーバーにつなぐのは Local Bridge だけ。

## セットアップ

```sh
npm install           # リポルートで (未実施なら)
npm run build:local-bridge
```

Node は 22.18 以上 (23 系は 23.6 以上。手元は 26 で確認)。
dev サーバーは `.mts` を node で直接実行するので、型を剥がす機能が既定で有効な版 (v22.18.0・v23.6.0 から) でないと、dev サーバーの起動で止まる。

Figma への取り込みは[リポルート README の共通手順](../../README.md#figma-への取り込み-共通手順)を参照
(選択する manifest は `plugins/local-bridge/manifest.json`)。

## 使い方

1. dev サーバーを起動する (リポルートで。止めるまで動き続ける)

   ```sh
   npm run dev:server                        # 結果は .dev-dump/ に置く
   npm run dev:server -- --out <ディレクトリ>  # 置き場所を変える
   ```

   候補のポート 47717〜47721 のうち、空いている最初のポートで起動し、`dev サーバー: http://localhost:<ポート>` と表示する。
   どれかの候補で dev サーバーがもう動いていれば、起動せずに終わる (制約を参照)。
   以下の curl の `47717` は、表示されたポート (Local Bridge の画面からコピーした文なら、その URL のポート) に読み替える。

2. Figma で Local Bridge を実行し、開いたままにする (最初の 1 回だけ人か computer use の操作が要る)。
   Local Bridge は候補のポートを順に探して dev サーバーにつなぎ、つないだ dev サーバーと、このファイルの名前と fileKey と、script の実行の合言葉を画面に出す。
   複数のファイル (タブ) でそれぞれ開いてよい (下の「複数のファイルで開く」)
3. 書き出しを依頼する。行き先のファイルを `?file=<fileKey>` でいつも指定する。
   dev サーバーは結果が届くまで待ってから、展開先 (`dir`) を含む JSON を返す

   ```sh
   curl -s -X POST 'localhost:47717/export?file=<fileKey>' -d '{"nodeIds":["9194:16583"]}'
   curl -s -X POST 'localhost:47717/export?file=<fileKey>' -d '{"nodeIds":["0:1"],"scale":1}'  # ページの id ならページ直下
   curl -s -X POST 'localhost:47717/export?file=<fileKey>'                                     # Figma で開いているページの選択
   curl -s -X POST 'localhost:47717/export?file=<fileKey>' -d '{"nodeIds":["9194:16583"],"images":"none"}'  # 構造だけ (画像を省く)
   curl -s -X POST 'localhost:47717/export?file=<fileKey>' -d '{"nodeIds":["9194:16583"],"images":"only"}'  # 画像だけ
   ```

   - fileKey は、Local Bridge の画面と「AI に渡す文」に出ている。
     Figma のファイルのリンク (`https://www.figma.com/design/<fileKey>/<ファイル名>?node-id=...`) の `<fileKey>` の部分も同じ値で、人からリンクを渡されたらそれを使ってよい。
     ただし、リンクに `/branch/` が入っている (ブランチのファイルの) ときは、AI はリンクからキーを取り出さず、どの fileKey に送るかを人に聞く (未確認の前提を参照)。
   - `file` の無い依頼は、積まずに HTTP 400 で断る。
     指定したファイルで Local Bridge が繋がっていなければ、積まずに HTTP 503 で断る (繋がっているかの判定は下の 503 の項)。
     どちらの本文にも、Local Bridge が繋がっているファイルの一覧 (`plugin`) が入る。
     AI はその一覧 (ファイル名と fileKey) を人に見せ、どのファイルに送るかを聞く。AI が自分で選ばない。

   - 結果は `<置き場所>/results/<version>/` に展開し、`<置き場所>/latest` がいちばん新しく成功した結果を指す。
     中身は Structure Dump の [ZIP の中身](../structure-dump/README.md#zip-の中身-schema-dump-v3)と同じで、まず `README.md` を読む。
     `version` と依頼の番号 `seq` は、dev サーバーを起動し直しても前回の続きから振る。結果は新しいほうから 20 個残す。
   - 本文の `images` で、書き出す中身を選べる。省くと `both` と同じ。
     - `both`: 構造と画像の両方。Structure Dump のメニューから書き出したものと同じ。
     - `none`: 構造だけ。画面フレームの PNG・ベクターの SVG (`assets/svg/`)・画像の素材 (`assets/`) を省く。
       構造の json・`_section.json`・`styles.json`・`variables.json`・`README.md`・`index.json` は出す。
     - `only`: 画像だけ。画面フレームの PNG と画像の素材 (`assets/`) だけを出す。
       構造の json・`_section.json`・`styles.json`・`variables.json`・SVG は出さない。
       `index.json` (画面フレームの一覧) と `README.md` は残す。
     - どれで書き出したかは、`index.json` の `meta.images` に入る。
     - 3 つ以外の値 (別の文字列・数値・`null` など) は、積まずに HTTP 400 で断る。
     - Local Bridge へ渡す依頼には、本文に `images` を書いたときだけ `images` が入る。Local Bridge は、無ければ `both` と読む。
   - 書き出せなかったとき (ノードが見つからない・すべて非表示など) は HTTP 422 で `error` に理由が入る。
   - 待ち行列はファイルごとにある。
     Local Bridge が前の依頼を書き出しているあいだに、同じファイル宛てに来た依頼は、断らずに待たせ、前の依頼が終わってから順に書き出す。
     別のファイル宛ての依頼は待たせず、そのファイルの Local Bridge へ渡す。
     書き出し中の Local Bridge からは何も届かない (重いページでは Figma ごと固まる) が、dev サーバーは、渡した依頼の結果がまだ返っていなければ書き出し中と見る。
     Figma のウィンドウがほかのアプリの裏にあると、書き出しが大きく遅れ、止まったように見えることもある (前に出すと進む)。
     画面がスリープかロックしているあいだも書き出しは止まり、画面を起こすと進む。
     スリープ中に進んだ書き出しが、警告 (「変数のモードを引けない」など) つきで欠けた結果になったことが 1 回ある。
     結果の `meta.warnings` (応答の `warnings`) に、同じノードの書き出しで普段は出ない警告があれば、画面を起こしたまま書き出し直す。
     非表示のため除外したノードのように、毎回出る警告は書き出し直しても消えない。
   - 指定したファイルで、書き出し中の依頼が無く、そのファイルの Local Bridge から 35 秒何も届いていなければ、繋がっていないと見て、依頼を積まずにすぐ HTTP 503 を返す。
   - 300 秒以内に結果が来なければ HTTP 504 (`?timeout=<秒>` で変えられる)。
     Claude Code の Bash ツールは既定で 120 秒で切れるので、大きな書き出しでは Bash の timeout も延ばす。
   - `file` の無い 400・503・504 の本文には、Local Bridge が繋がっているファイルの一覧 (`plugin`) が入る (繋がっていないファイルは載らない。ほかの理由の 400 には入らない)。
     503 の `error` には、fileKey か起動 id を名乗らない古い版の Local Bridge が 35 秒以内に来ていれば、そのことと「build し直して開き直す」も添える。
     1 つのファイルの欄は次のとおり。
     - `fileKey`・`fileName`: ファイルの fileKey と名前 (名前は Local Bridge が名乗ったもの)。
     - `lastSeenAt`: そのファイルの Local Bridge から最後に何か届いた時刻。
     - `processing`: そのファイルの Local Bridge へ渡してまだ結果が返っていない依頼 (`seq`・種類 `kind` (書き出しは `export`、script は `run`)・`nodeIds`・`images` (`none` か `only` のときだけ)・渡してからの秒数 `elapsedSeconds`)。
   - 504 になっても依頼は消えない。送り直さずに、504 の `seq` で `GET /status?seq=<seq>` を呼んで待つ。
     この呼び出しは、その依頼が決着するまで待ち、`state` で今の様子を返す。
     Bash の timeout も延ばす。
     Claude Code の Bash ツールは最大 600 秒なので、`timeout` はそれより短くする。
     ```sh
     curl -s 'localhost:47717/status?seq=12&timeout=540'
     ```
     - `done`: 書き出せた。`dir` などは書き出しの応答と同じ。
     - `failed`: 書き出せなかった。`error` に理由が入る。
     - `skipped`: Local Bridge がこの依頼を飛ばしてあとの依頼に進んだので、もう書き出されない (走り直した Local Bridge が受け取るのは最後の依頼だけ。制約を参照)。送り直す。
     - `queued` (順番待ち) か `processing` (Local Bridge へ渡して結果がまだ): 待つ長さ (既定 300 秒、`?timeout=<秒>`) を過ぎて HTTP 504 で返った。もう一度待つ。
       応答の `fileKey` がその依頼の行き先のファイルで、`plugin` からそのファイルの欄を引いて様子を見る。
       `queued` で `plugin` にそのファイルが無ければ、そのファイルの Local Bridge が開いていない。人か computer use に Local Bridge を開いてもらう。
       `processing` のまま、そのファイルの `processing.elapsedSeconds` が伸び続けるときは、Figma が前に出ているか、Local Bridge が開いているかを人か computer use で確かめる (書き出しの途中で Local Bridge を閉じても `processing` のまま残る)。
     - HTTP 404: この起動の dev サーバーが受けていない依頼 (dev サーバーを起動し直す前の依頼など)。書き出しは送り直す。
       script は前の dev サーバーのときに実行したかもしれないので、書き換える script は送り直さず、[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)の 2 に従う (読み取りだけの script は送り直してよい)。
   - `<置き場所>/status.json` と `GET /status` は、最後に受けた結果 (`version`・`seq`・`images` (`none` か `only` のときだけ)・`dir`・`fileKey`・`fileName`・`warnings`・`error`) を返す。
     `status.json` も `latest` も、どのファイルの書き出しでも全体で 1 つなので、`fileKey` (依頼の行き先) と `fileName` で、どのファイルの結果かを確かめる。
     複数のファイルで開いているときは、`latest` を読まず、書き出しの応答の `dir` を読む (`latest` は別のファイルの結果に替わっていることがある)。
     `fileName` は書き出した中身のファイル名で、書き出せなかったときは Local Bridge が名乗った名前。
     `GET /status` には `plugin` (繋がっているファイルの一覧) と、結果の置き場所 `outDir` も入る。
     `GET /status?file=<fileKey>` は、そのファイルの最後の結果を返す (この起動でそのファイルの結果がまだ無ければ `version` は 0。起動し直した直後は、`status.json` の結果がそのファイルのものなら、それを返す)。
     `GET /status?after=<version>` は、それより新しい結果が届くまで待つ。
     `file=<fileKey>` も付けると、そのファイルの新しい結果だけを待つ (付けなければ、どのファイルの結果でも返る)。
     300 秒待っても届かなければ HTTP 504 で、待つ長さは `?timeout=<秒>` で変えられる。
4. コードを直したら build する。
   ホットリロードで Local Bridge が走り直し、自分のファイル宛ての最後の書き出しの依頼をもう一度書き出して送る (複数のファイルで開いていれば、それぞれが走り直す)

   ```sh
   npm run build:dump          # Structure Dump の書き出しを直したとき (Structure Dump と Local Bridge の両方を作り直す)
   npm run build:local-bridge  # Local Bridge のコードだけを直したとき
   curl -s 'localhost:47717/status?file=<fileKey>&after=<そのファイルの直前の version>'  # そのファイルで走り直した結果が届くまで待つ
   ```

   走り直した結果は、応答の `dir` を読む (複数のファイルで開いていると、`latest` はあとから届いた別のファイルの結果を指すことがある)。

   Figma のメニュー「プラグインをホットリロード」が効いている必要がある。

Local Bridge の画面には、いつ・なぜ (新しい依頼か、起動より前に積まれていた依頼か) 書き出したか・実行したかの記録が出る。
画面の上の「小さくする」を押すと、状態の 1 行と「広げる」ボタンだけの小さな窓になる。
依頼で問題があると、状態の行にそう出る (中身は広げた画面の記録にある)。
小さくしたかは残さない。開き直しや build での走り直しでは、広げた大きさで開く。

### 複数のファイルで開く

Local Bridge は、Figma のファイル (タブ) ごとに開ける。
それぞれの Local Bridge は、自分のファイルの fileKey (`figma.fileKey`) とファイル名を名乗って dev サーバーにつなぎ、自分のファイル宛ての依頼だけを受け取る。
次の挙動は、2026-10-27 に Figma デスクトップ (macOS) で実測した。

- 表示していない裏のタブの Local Bridge も、依頼を処理する。
- 別々のタブの Local Bridge は並行に動く。
  片方が重い処理でふさがっていても、もう片方は待たずに処理する。
  dev サーバーも、待ち行列・処理中の依頼・繋がっているかの判定をファイルごとに持つ (依頼の番号 `seq` は全体で 1 本の通し番号)。
- 開発用プラグインの `figma.fileKey` は、manifest に `"enablePrivatePluginApi": true` が無いと取れない (`null` になる)。
  書いてあれば、ファイルのリンクの `<fileKey>` と同じ値になる (ブランチのファイルは未確認)。

行き先の取り違えを防ぐため、次のように動く。

- 依頼には、1 つのファイルでだけ開いているときも、行き先の `?file=<fileKey>` がいつも要る (無ければ 400)。
- 指定したファイルで Local Bridge が繋がっていなければ断り (503)、繋がっているファイルの一覧を返す。
  AI はどのファイルに送るかを人に聞き、自分で選ばない。
- Local Bridge は、届いた依頼の fileKey が自分のファイルと違えば、書き出しも script も実行しない (dev サーバーの振り分けに不具合があっても止まる)。
- Local Bridge は、`figma.fileKey` が取れなければ dev サーバーにつながず、画面に理由を出す。
  manifest を取り込み直してから開き直す。
- Local Bridge は起動ごとに乱数の起動 id を作り、fileKey と一緒に名乗る。
  同じファイルを 2 つのタブで開くなどで、同じファイルに Local Bridge が 2 つあるときは、あとから来た起動だけに依頼を渡す (ホットリロード・開き直しも、新しい起動として来る)。
  前の起動の Local Bridge には、dev サーバーが HTTP 409 を返し、その Local Bridge は依頼を受けるのをやめて、画面に理由を出す。
  止まったほうを使うなら、閉じて開き直す (開き直したほうがあとの起動になる)。
  止まる前に渡した依頼の結果は、止まったほうからでも受ける。
- fileKey か起動 id を名乗らずに `/next` に来た古い版の Local Bridge には、dev サーバーは依頼を渡さず、build し直して開き直すよう HTTP 400 で返す (Local Bridge の画面の記録に出る)。
- Local Bridge は、`GET /hello` の版 (`protocol`) が違う古い版の dev サーバーにはつながず、画面に「古い版の dev サーバー。止めて起動し直す」と出して探し続ける。
- dev サーバーは、繋がっていないファイルのうち、そのファイル宛てでまだ渡していない依頼も無いものは忘れる。
  覚えておく依頼は 100 件までで、古いほうから忘れる。
  ただし、まだ渡していない依頼・処理中の依頼・ファイルごとの最後の書き出しの依頼は、ほかのファイルの依頼が多くても忘れない。

合言葉はファイルごと (下の「合言葉の扱い」)。
結果の置き場所の `status.json` と `latest` は全体で 1 つで、どのファイルの書き出しかは `fileKey` と `fileName` で見分ける (そのファイルの結果だけを見るなら `GET /status?file=<fileKey>`)。

### script の実行

Plugin API のコードを送ると、Local Bridge が実行して返り値を JSON で返す (Figma MCP の use_figma と同じことを、回数の上限なしに手元で行う)。
読み取りだけでなく、ファイルの書き換えや削除もできる。
書き換える script は、[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)に従って送る。
書き換える前と後を書き出して `npm run compare` で比べ (構造の差分と、before・after・色が違う画素を赤くした差分の画像)、問題があれば Figma の取り消しで戻す。
手順が頼る取り消しの挙動は、2026-10-26・27 に Figma デスクトップ 126.10.11 で実測した。

- script の頭と終わりで `figma.commitUndo()` を呼ぶと、その script の書き換えが取り消しの 1 手になる (`figma.triggerUndo()` でも Cmd+Z でも 1 回で戻る)。
  呼ばないと、続けて送った script の書き換えが 1 手にまとまる。
- `figma.triggerUndo()` は、そのタブの取り消しの履歴のいちばん新しい 1 手を戻す。
  script のあとに人が手で書き換えていれば、そちらが先に戻る。
- 書き出し (`/export`) は取り消しの履歴に手を積まない (書き換えと取り消しのあいだに書き出しを挟んでも、取り消しは script の 1 手を戻した)。

1. 人が Local Bridge の画面の「AI に渡す文をコピー」を押し、実行を任せる AI のセッションに貼る。
   渡す文には、dev サーバーの URL・そのタブのファイルの名前と fileKey・`?file=` を付けた curl の例・そのファイルの合言葉 (`X-Run-Token`) が入る。
   合言葉はファイルごとなので、複数のファイルで script を実行させるときは、ファイルのタブごとにコピーして渡す。
   コピーするときに最新の合言葉を読み直す (まだ無ければ作る) ので、別のタブで作り直されたあとでも、古い合言葉の文はコピーしない。
2. AI は本文にコードを入れ、行き先のファイルを `?file=<fileKey>` に、合言葉をヘッダに付けて送る

   ```sh
   curl -s -X POST 'localhost:47717/run?file=<fileKey>' -H 'X-Run-Token: <合言葉>' \
     --data-binary 'return figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));'
   curl -s -X POST 'localhost:47717/run?file=<fileKey>' -H 'X-Run-Token: <合言葉>' --data-binary @script.js
   ```

   - 本文は async 関数の本体として、`figma` を引数にして実行する。
     `await` が使え、`return` した値が応答の `value` に入る。
     返り値は JSON にして返す。
     ノードをそのまま返すと `{"id": "..."}` だけになるので、要る値を取り出してから返す。
     関数などの JSON にない値は、`JSON.stringify` と同じく `null` になるか、消える。
   - 成功は HTTP 200 で `{"seq": 3, "value": ...}` が返る (return しなければ `value` は `null`)。
   - 失敗は HTTP 422 で、`error` に理由が入る。理由の文で、実行したかどうかが分かる。
     - 「実行していない」: 合言葉が違う (別のファイルの合言葉を含む)・このファイルの合言葉がまだ無い (作り直したあと、このタブでまだコピーしていない)・コードを読めない (構文エラー)・別のファイル宛ての依頼が届いた (dev サーバーの振り分けの不具合。Local Bridge は依頼の fileKey が自分のファイルと違えば実行しない)。
       直して送り直してよい。合言葉が違う・無いときは、そのファイルのタブで渡す文をコピーし直してもらう。
     - 「途中で例外を投げた (それまでの書き換えは残っている)」: 書き換える script は送り直さず、[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)の 2 に従う。
       読み取りだけの script は、直して送り直してよい。
     - 「最後まで実行したが」: 返り値を JSON にできない・大きすぎる (JSON で 100 万文字まで)。
       script の書き換えは済んでいる。同じ script を送り直すと書き換えが二重にかかるので、送り直さずに、要る値は読み取りの script で確かめる。
     - 「実行したが、結果の送信に失敗」: Local Bridge から dev サーバーへ結果が届かなかった。
       書き換えは済んでいるので、送り直さずに、要る値は読み取りの script で確かめる。
   - HTTP 400 は依頼の形が違う (`file` が無い・`X-Run-Token` が無い・本文が空・`timeout` が正の数でない)。積んでいないので、直して送り直す。
     `file` が無いときは、書き出しと同じく、本文の一覧を人に見せて行き先を聞く。
   - HTTP 503 は、指定したファイルで Local Bridge が繋がっていない (書き出しと同じ)。積んでいないので、そのファイルで Local Bridge を開いてもらってから送り直す。
     別のファイルに送るかは、本文の一覧を人に見せて聞く。
   - 行き先のファイルの、書き出しと同じ待ち行列に入り、そのファイルの前の依頼が終わってから順に実行する。
   - 待つ長さの既定は 90 秒 (`?timeout=<秒>`)。
     Claude Code の Bash ツールの既定 (120 秒) で curl が止められる前に、`seq` の入った HTTP 504 を返すため。
   - 504 の `error` が「プラグインに渡せなかったので取り消した」なら、渡す前に取り消した (`cancelled`)。
     実行していないので、待たずに送り直してよい。前の依頼が終わらないときは、`?timeout=<秒>` と Bash の timeout を延ばして送る。
   - それ以外の 504 では、送り直さずに `GET /status?seq=<seq>` で待つ (書き出しと同じ)。
     script では、`state` に次の 2 つが加わる。
     - `cancelled`: Local Bridge へ渡す前に、依頼した側が待つのをやめた (時間切れか、curl が止められた) ので取り消した。
       実行していないので、送り直してよい。取り消した script は、あとで開いた Local Bridge にも渡さない。
     - `abandoned`: Local Bridge へ渡したのに、結果が返らないままそのファイルの Local Bridge が次へ進んだ (走り直した・閉じて開き直した)。
       途中まで実行したかもしれないので、書き換える script は送り直さず、[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)の 2 に従う。
       読み取りだけの script は送り直してよい。
     script の `skipped` は、まだ渡さないうちにあとの依頼が先に渡った依頼で、実行していない。
   - 応答が返らないまま curl が止まったとき (`seq` が分からない) は、実行したかが分からない。
     書き換える script は送り直さず、[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)の 2 に従う (読み取りだけの script は送り直してよい)。
   - 成功でも失敗でも、`status.json`・`version`・`latest` は変わらない (書き出しの結果ではないため)。
3. 合言葉を取り消したいときは、どれかのタブの Local Bridge の画面で「合言葉を作り直す」を押す。
   すべてのファイルの合言葉を消し、押したタブのファイルの合言葉だけを作り直す。
   前の合言葉の付いた script は、どのファイルでも実行しない (渡したすべての AI で使えなくなる)。
   開いたままの別のタブのファイルは、次に「AI に渡す文をコピー」を押したときに新しい合言葉ができる (それまでは、そのファイルの script は実行しない)。
   ただし、それまでに実行した script が Local Bridge に仕込んだもの (`figma.ui.onmessage` の書き換えなど) は、Local Bridge を閉じるまで残る。
   作り直したら、Local Bridge も開き直す。

合言葉の扱い:

- 合言葉はファイルごとに 1 つ。
  Local Bridge が 16 バイトの乱数で作り、Figma の端末の保存場所 (`figma.clientStorage`) にファイルごとのキー (`devRunToken:<fileKey>`) で残す。
  同じファイルなら、ホットリロード・Local Bridge の開き直しでも同じ合言葉が効く。
  前の版が全ファイル共通で使っていたキー (`devRunToken`) は読まない (作り直すときに消す)。
- 照合は Local Bridge がする。script の依頼ごとに、そのタブのファイルの最新の合言葉を保存場所から読んで比べる。
  別のタブで作り直した結果は、開いたままのタブの次の照合にすぐ効く (2026-10-27 に Figma デスクトップ (macOS) で実測)。
  dev サーバーは合言葉を照合せず、中継するだけ。書き出し (`/export`) には合言葉は要らない。
- 合言葉を持っていれば、どのセッションからでも、そのファイルでだけ実行できる。
  別のファイルの合言葉では実行しない (`?file=` を一覧の別のファイルに差し替えて送っても、そのファイルの合言葉が無ければ実行されない)。
  ファイル (スクリプト・メモ・CLAUDE.md など) に書いて残さない。使い終わったら作り直す。
- 防げるもの: 合言葉を渡していない別のセッションやアプリが `/run` に送っても、実行されない。
  ブラウザで開いたサイトからは `/run` に送れない (下の制約の最後の項)。
- 防げないもの: 同じ PC で待ち構える悪いプロセス。
  dev サーバーより先にポートを取る・Local Bridge の口 `/next` から依頼 (コードと合言葉) を読む・AI の会話の記録から合言葉を読む、ができる。
- 残る余地 (防げないもの・制約の最後の項) は受け入れる。
  そのうえで、守りは localhost でだけ待ち受ける・AI 側の口は Origin 付きの送信を断る・Local Bridge を開いているあいだだけ実行する・合言葉、の 4 つとし、デザイナーの手元でも同じ形で使う (2026-10-22 の判断)。

制約:

- Figma の 1 つのタブで同時に動かせるプラグインは 1 つ。
  そのタブでほかのプラグイン (Structure Dump を含む) を起動すると Local Bridge は閉じ、そのファイル宛ての依頼は処理されなくなる。
  終わったら Local Bridge を開き直す。
- ポートは、候補の 47717〜47721 (manifest の `devAllowedDomains` と同じ値) のうち、空いている最初のポート。dev サーバーは同時に 1 つしか動かせない。
  ポートが分からないときは、候補に順に `curl -s localhost:<ポート>/hello` を聞き、`app` に `structure-dump-dev-server` を返したポートを使う (`root` は dev サーバーを起動したリポの場所)。
  `npm run dev:server` が「dev サーバーはもう http://localhost:<ポート> で動いている」と出して終わったら、ほかのセッションが起動した dev サーバーが動いている。
  止めずに、そのまま依頼する。結果はそのサーバーの置き場所に入る。
  置き場所は表示され、`GET /status` の `outDir` でも分かる。
  止めると、それを使っているほかのセッションの依頼も止まる。
  「古い版の dev サーバーが … で動いている」と出して終わったら、Local Bridge はその dev サーバーにつながらないか、つながってもその dev サーバーの依頼を実行しない (依頼をファイルごとに振り分ける前の版の依頼には、行き先のファイルが無い)。
  使っているセッションが無いかを人に確かめてから止め、`npm run dev:server` で起動し直す。
  「候補のポート … がどれも、dev サーバーとして答えない相手に使われている」と出して終わったら、どれかのアプリを止めるか、表示に従って候補を変える。
  ただし相手は答えられなくなった dev サーバーで、ほかのセッションが使っているかもしれないので、止める前に何が使っているかを人に確かめる。
- ホットリロードが走るのは、Figma が取り込んだ manifest のあるディレクトリで build したときだけ。
  別の worktree で build しても、取り込んだほうの Local Bridge は走り直さない。
- 走り直した Local Bridge が受け取るのは、自分のファイル宛てでまだ渡していない最後の依頼 1 件だけ。それより前に積まれて応答していない、そのファイル宛ての依頼は、あとからも処理せず、時間切れになる。
  まだ渡していない依頼が無ければ、自分のファイル宛ての最後の書き出しの依頼をもう一度書き出す。渡し済みの script は実行し直さない。
  別のファイル宛ての依頼は受け取らない。
- 処理の途中で Local Bridge を閉じても、dev サーバーには分からない。
  その依頼は処理中のまま残り (`plugin` のそのファイルの `processing.elapsedSeconds` が伸び続ける)、同じファイル宛ての次の依頼も待たせる。
  そのファイルで Local Bridge を開き直すと、前の項のとおりに依頼を受け取る。
- 終わらない script・プラグインを閉じる script (`figma.closePlugin()`)・`figma.ui.onmessage` を書き換える script を送ると、それ以降の依頼は処理されない。
  Local Bridge を閉じて開き直す。
- dev サーバーは使うときだけ起動する。
  localhost でだけ待ち受け、localhost 以外の名前で来た送信と、AI 側の口 (`/export`・`/run`・`/status`) への Origin 付きの送信 (ブラウザで開いたサイトからの送信) は断る。
  ただし Local Bridge の口は Figma のプラグインと同じ `Origin: null` を受ける。
  ブラウザで開いたサイトの sandbox の iframe から、依頼 (script のコードと合言葉を含む) を読み、結果を差し替えられる余地が残る (読んだ合言葉で `/run` は呼べない)。

## 未確認の前提 (Figma 実機での動作確認推奨)

- 終わらない script (同期の無限ループ) を送ったとき、Local Bridge を閉じて止められること
- ブランチのファイル (リンクが `figma.com/design/<fileKey>/branch/<branchKey>/...`) で、`figma.fileKey` がリンクのどちらのキーになるか。
  元のファイルでも Local Bridge を開いていると、違うほうのキーを指定した依頼が元のファイルに届きうる。
  だから、リンクに `/branch/` が入っているときは、AI はキーを取り出さず、人に聞く (Local Bridge の画面や渡す文の fileKey を使う)
