# Local Bridge

AI が Figma のデータを、クリックも Figma MCP の回数上限もなしに読み書きするためのプラグイン。
Local Bridge を開いておくと、AI が curl で手元の dev サーバーへ送った依頼を Local Bridge が実行し、結果を AI が受け取る。
依頼は 2 種類ある。

- 書き出し: [Structure Dump](../structure-dump/) と同じ書き出しをして、ZIP を展開した結果を AI が読む。
  Local Bridge は Structure Dump の書き出し (`plugins/structure-dump/src/dump.ts`) を build で取り込むので、
  Structure Dump から書き出したものと同じ ZIP になる。
- script の実行: Plugin API のコードを渡して実行させる (「script の実行」)。

リリースの zip には入れない。
使う人 (開発者もデザイナーも) は、リポジトリを clone して取り込む (導入手順を参照)。
Structure Dump と Component Spec は通信しない。dev サーバーにつなぐのは Local Bridge だけ。

## 導入手順 (デザイナー向け)

開発者でなくても、手元の Figma を AI に読み書きさせたいときに使える。

AI は `/export` で画面フレームの構造と画像を書き出して読み、`/run` で Plugin API の script を流す (組み合わせ表を並べる・名前の揺れを検査する、など)。
Figma の公式 MCP と違って回数の上限が無い。
Figma のログインや MCP の認証は要らない (script の実行だけ合言葉が要る)。

前提:

- Figma デスクトップアプリ (開発プラグインを取り込めるのはデスクトップアプリだけ)
- Node 22.18 以上。
  ただし 23 系は 23.6 以上 (手元は 26 で確認)。
  dev サーバーは `.mts` を node で直接実行するので、型を剥がす機能が既定で有効な版 (v22.18.0・v23.6.0 から) でないと、dev サーバーの起動で止まる。
  未インストールなら https://nodejs.org/ から入れる。
- git
- Claude Code など、手元で curl を打てる AI (無いと Local Bridge を使う意味が無い)。
  Claude Code は https://code.claude.com/docs/ja/overview から入れる。

手順:

1. リポジトリを clone する。
   置いた場所は、取り込んだあと動かさない (理由は[共通手順](../../README.md#figma-への取り込み-共通手順)の 2)。

   ```sh
   git clone https://github.com/simiraaaa/figma-plugins.git
   ```

2. clone したディレクトリ (リポルート) で build する ([リポルート README のセットアップ](../../README.md#セットアップ))。

   ```sh
   npm install
   npm run build
   ```

3. dev サーバーを起動し、動かしたままにする ([使い方](#使い方)の 1)。
   Claude Code に頼むなら、background で動かしてもらう。

   ```sh
   npm run dev:server
   ```

4. Figma で **プラグイン** → **開発** → **マニフェストからプラグインをインポート…** から、`plugins/local-bridge/manifest.json` を取り込む ([共通手順](../../README.md#figma-への取り込み-共通手順))。
   改名前の Dev Loop (`plugins/dev-loop/manifest.json`) を取り込んでいたら、その項目を**開発**の一覧から削除してから取り込む。
5. 対象のファイルを開き、Local Bridge を起動して開いたままにする。
6. Local Bridge の画面の「AI に渡す文をコピー」を押し、AI のセッションに貼る。
   渡す文には、dev サーバーの URL・合言葉と、この README と[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)の絶対パスが入る。
   合言葉は、script の実行を許す鍵で、Local Bridge が自動で作る (詳しくは [script の実行](#script-の実行))。

注意:

- 書き出しのあいだは、Figma のウィンドウを前に出し、画面をスリープ・ロックさせない (裏にあると遅れ、スリープ・ロック中は止まる。[使い方](#使い方)の 3 の、書き出し中の依頼の項)。
- `/run` は、開いているファイルを書き換えも削除もできる。
  合言葉は、実行を任せる AI にだけ渡す。

使い終わったら:

1. Local Bridge の画面の「合言葉を作り直す」を押す ([script の実行](#script-の実行)の 3)。
2. dev サーバーを止める。
   起動した端末で Ctrl+C を押す。
   Claude Code に background で動かしてもらったなら、そのセッションに止めてもらう。
   ほかのセッションが同じ dev サーバーを使っていれば、その依頼も止まる (制約を参照)。
3. Local Bridge を閉じる。

## セットアップ

```sh
npm install           # リポルートで (未実施なら)
npm run build:local-bridge
```

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
   Local Bridge は候補のポートを順に探して dev サーバーにつなぎ、つないだ dev サーバーと、script の実行の合言葉を画面に出す
3. 書き出しを依頼する。dev サーバーは結果が届くまで待ってから、展開先 (`dir`) を含む JSON を返す

   ```sh
   curl -s -X POST localhost:47717/export -d '{"nodeIds":["9194:16583"]}'
   curl -s -X POST localhost:47717/export -d '{"nodeIds":["0:1"],"scale":1}'  # ページの id ならページ直下
   curl -s -X POST localhost:47717/export                                     # Figma で開いているページの選択
   curl -s -X POST localhost:47717/export -d '{"nodeIds":["9194:16583"],"images":"none"}'  # 構造だけ (画像を省く)
   curl -s -X POST localhost:47717/export -d '{"nodeIds":["9194:16583"],"images":"only"}'  # 画像だけ
   ```

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
   - Local Bridge が前の依頼を書き出しているあいだに来た依頼は、断らずに待たせ、前の依頼が終わってから順に書き出す。
     書き出し中の Local Bridge からは何も届かない (重いページでは Figma ごと固まる) が、dev サーバーは、渡した依頼の結果がまだ返っていなければ書き出し中と見る。
     Figma のウィンドウがほかのアプリの裏にあると、書き出しが大きく遅れ、止まったように見えることもある (前に出すと進む)。
     画面がスリープかロックしているあいだも書き出しは止まり、画面を起こすと進む。
     スリープ中に進んだ書き出しが、警告 (「変数のモードを引けない」など) つきで欠けた結果になったことが 1 回ある。
     結果の `meta.warnings` (応答の `warnings`) に、同じノードの書き出しで普段は出ない警告があれば、画面を起こしたまま書き出し直す。
     非表示のため除外したノードのように、毎回出る警告は書き出し直しても消えない。
   - 書き出し中の依頼が無く、Local Bridge から 35 秒何も届いていなければ、繋がっていないと見て、依頼を積まずにすぐ HTTP 503 を返す。
   - 300 秒以内に結果が来なければ HTTP 504 (`?timeout=<秒>` で変えられる)。
     Claude Code の Bash ツールは既定で 120 秒で切れるので、大きな書き出しでは Bash の timeout も延ばす。
   - 503 と 504 の本文には、Local Bridge の様子 (`plugin`) が入る。
     `plugin.processing` は Local Bridge へ渡してまだ結果が返っていない依頼 (`seq`・種類 `kind` (書き出しは `export`、script は `run`)・`nodeIds`・`images` (`none` か `only` のときだけ)・渡してからの秒数 `elapsedSeconds`) で、`plugin.lastSeenAt` は最後に Local Bridge から何か届いた時刻。
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
       `queued` で `plugin.processing` が無く、`plugin.lastSeenAt` が 35 秒より前なら、Local Bridge が開いていない。人か computer use に Local Bridge を開いてもらう。
       `processing` のまま `plugin.processing.elapsedSeconds` が伸び続けるときは、Figma が前に出ているか、Local Bridge が開いているかを人か computer use で確かめる (書き出しの途中で Local Bridge を閉じても `processing` のまま残る)。
     - HTTP 404: この起動の dev サーバーが受けていない依頼 (dev サーバーを起動し直す前の依頼など)。書き出しは送り直す。
       script は前の dev サーバーのときに実行したかもしれないので、書き換える script は送り直さず、[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)の 2 に従う (読み取りだけの script は送り直してよい)。
   - `<置き場所>/status.json` と `GET /status` は、最後に受けた結果 (`version`・`seq`・`images` (`none` か `only` のときだけ)・`dir`・`fileName`・`warnings`・`error`) を返す。
     `GET /status` には `plugin` と、結果の置き場所 `outDir` も入る。
     `GET /status?after=<version>` は、それより新しい結果が届くまで待つ (どの依頼の結果でも返る)。
     300 秒待っても届かなければ HTTP 504 で、待つ長さは `?timeout=<秒>` で変えられる。
4. コードを直したら build する。
   ホットリロードで Local Bridge が走り直し、最後の書き出しの依頼をもう一度書き出して送る

   ```sh
   npm run build:dump          # Structure Dump の書き出しを直したとき (Structure Dump と Local Bridge の両方を作り直す)
   npm run build:local-bridge  # Local Bridge のコードだけを直したとき
   curl -s 'localhost:47717/status?after=<直前の version>'  # 走り直した結果が届くまで待つ
   ```

   Figma のメニュー「プラグインをホットリロード」が効いている必要がある。

Local Bridge の画面には、いつ・なぜ (新しい依頼か、起動より前に積まれていた依頼か) 書き出したか・実行したかの記録が出る。

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
   渡す文には、dev サーバーの URL と合言葉 (`X-Run-Token`) が入る。
2. AI は本文にコードを入れ、合言葉をヘッダに付けて送る

   ```sh
   curl -s -X POST localhost:47717/run -H 'X-Run-Token: <合言葉>' \
     --data-binary 'return figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));'
   curl -s -X POST localhost:47717/run -H 'X-Run-Token: <合言葉>' --data-binary @script.js
   ```

   - 本文は async 関数の本体として、`figma` を引数にして実行する。
     `await` が使え、`return` した値が応答の `value` に入る。
     返り値は JSON にして返す。
     ノードをそのまま返すと `{"id": "..."}` だけになるので、要る値を取り出してから返す。
     関数などの JSON にない値は、`JSON.stringify` と同じく `null` になるか、消える。
   - 成功は HTTP 200 で `{"seq": 3, "value": ...}` が返る (return しなければ `value` は `null`)。
   - 失敗は HTTP 422 で、`error` に理由が入る。理由の文で、実行したかどうかが分かる。
     - 「実行していない」: 合言葉が違う・コードを読めない (構文エラー)。直して送り直してよい。
     - 「途中で例外を投げた (それまでの書き換えは残っている)」: 書き換える script は送り直さず、[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)の 2 に従う。
       読み取りだけの script は、直して送り直してよい。
     - 「最後まで実行したが」: 返り値を JSON にできない・大きすぎる (JSON で 100 万文字まで)。
       script の書き換えは済んでいる。同じ script を送り直すと書き換えが二重にかかるので、送り直さずに、要る値は読み取りの script で確かめる。
     - 「実行したが、結果の送信に失敗」: Local Bridge から dev サーバーへ結果が届かなかった。
       書き換えは済んでいるので、送り直さずに、要る値は読み取りの script で確かめる。
   - HTTP 400 は依頼の形が違う (`X-Run-Token` が無い・本文が空・`timeout` が正の数でない)。積んでいないので、直して送り直す。
   - HTTP 503 は Local Bridge が繋がっていない (書き出しと同じ)。積んでいないので、Local Bridge を開いてから送り直す。
   - 書き出しと同じ待ち行列に入り、前の依頼が終わってから順に実行する。
   - 待つ長さの既定は 90 秒 (`?timeout=<秒>`)。
     Claude Code の Bash ツールの既定 (120 秒) で curl が止められる前に、`seq` の入った HTTP 504 を返すため。
   - 504 の `error` が「プラグインに渡せなかったので取り消した」なら、渡す前に取り消した (`cancelled`)。
     実行していないので、待たずに送り直してよい。前の依頼が終わらないときは、`?timeout=<秒>` と Bash の timeout を延ばして送る。
   - それ以外の 504 では、送り直さずに `GET /status?seq=<seq>` で待つ (書き出しと同じ)。
     script では、`state` に次の 2 つが加わる。
     - `cancelled`: Local Bridge へ渡す前に、依頼した側が待つのをやめた (時間切れか、curl が止められた) ので取り消した。
       実行していないので、送り直してよい。取り消した script は、あとで開いた Local Bridge にも渡さない。
     - `abandoned`: Local Bridge へ渡したのに、結果が返らないまま Local Bridge が次へ進んだ (走り直した・閉じて開き直した)。
       途中まで実行したかもしれないので、書き換える script は送り直さず、[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)の 2 に従う。
       読み取りだけの script は送り直してよい。
     script の `skipped` は、まだ渡さないうちにあとの依頼が先に渡った依頼で、実行していない。
   - 応答が返らないまま curl が止まったとき (`seq` が分からない) は、実行したかが分からない。
     書き換える script は送り直さず、[書き換えの手順](../../.claude/skills/figma-safe-edit/SKILL.md)の 2 に従う (読み取りだけの script は送り直してよい)。
   - 成功でも失敗でも、`status.json`・`version`・`latest` は変わらない (書き出しの結果ではないため)。
3. 合言葉を取り消したいときは、Local Bridge の画面の「合言葉を作り直す」を押す。
   前の合言葉の付いた script は実行しない (渡したすべての AI で使えなくなる)。
   ただし、それまでに実行した script が Local Bridge に仕込んだもの (`figma.ui.onmessage` の書き換えなど) は、Local Bridge を閉じるまで残る。
   作り直したら、Local Bridge も開き直す。

合言葉の扱い:

- 合言葉は Local Bridge が作り、Figma の端末の保存場所 (`figma.clientStorage`) に残す。
  ホットリロード・Local Bridge の開き直し・別のファイルでも、同じ合言葉が効く。
- 照合は Local Bridge がする。dev サーバーは合言葉を照合せず、中継するだけ。
- 合言葉を持っていれば、どのセッションからでも、どの Figma ファイルでも実行できる。
  ファイル (スクリプト・メモ・CLAUDE.md など) に書いて残さない。使い終わったら作り直す。
- 防げるもの: 合言葉を渡していない別のセッションやアプリが `/run` に送っても、実行されない。
  ブラウザで開いたサイトからは `/run` に送れない (下の制約の最後の項)。
- 防げないもの: 同じ PC で待ち構える悪いプロセス。
  dev サーバーより先にポートを取る・Local Bridge の口 `/next` から依頼 (コードと合言葉) を読む・AI の会話の記録から合言葉を読む、ができる。
- 残る余地 (防げないもの・制約の最後の項) は受け入れる。
  そのうえで、守りは localhost でだけ待ち受ける・AI 側の口は Origin 付きの送信を断る・Local Bridge を開いているあいだだけ実行する・合言葉、の 4 つとし、デザイナーの手元でも同じ形で使う (2026-10-22 の判断)。

制約:

- Figma で同時に動かせるプラグインは 1 つ。
  ほかのプラグイン (Structure Dump を含む) を起動すると Local Bridge は閉じ、依頼は処理されなくなる。
  終わったら Local Bridge を開き直す。
- Local Bridge は 1 つだけ開く。
  複数のファイルで開くと、依頼はどれか 1 つの Local Bridge に渡り、どのファイルで処理するかは選べない (書き出しは `fileName` で分かる)。
  処理中の依頼を取り違え、script の `state` を `abandoned` と答えることもある。
- ポートは、候補の 47717〜47721 (manifest の `devAllowedDomains` と同じ値) のうち、空いている最初のポート。dev サーバーは同時に 1 つしか動かせない。
  ポートが分からないときは、候補に順に `curl -s localhost:<ポート>/hello` を聞き、`app` に `structure-dump-dev-server` を返したポートを使う (`root` は dev サーバーを起動したリポの場所)。
  `npm run dev:server` が「dev サーバーはもう http://localhost:<ポート> で動いている」と出して終わったら、ほかのセッションが起動した dev サーバーが動いている。
  止めずに、そのまま依頼する。結果はそのサーバーの置き場所に入る。
  置き場所は表示され、`GET /status` の `outDir` でも分かる。
  止めると、それを使っているほかのセッションの依頼も止まる。
  「古い版の dev サーバーが … で動いている」と出して終わったら、Local Bridge はその dev サーバーにつながらない。
  使っているセッションが無いかを人に確かめてから止め、`npm run dev:server` で起動し直す。
  「候補のポート … がどれも、dev サーバーとして答えない相手に使われている」と出して終わったら、どれかのアプリを止めるか、表示に従って候補を変える。
  ただし相手は答えられなくなった dev サーバーで、ほかのセッションが使っているかもしれないので、止める前に何が使っているかを人に確かめる。
- ホットリロードが走るのは、Figma が取り込んだ manifest のあるディレクトリで build したときだけ。
  別の worktree で build しても、取り込んだほうの Local Bridge は走り直さない。
- 走り直した Local Bridge が受け取るのは、まだ渡していない最後の依頼 1 件だけ。それより前に積まれて応答していない依頼は、あとからも処理せず、時間切れになる。
  まだ渡していない依頼が無ければ、最後の書き出しの依頼をもう一度書き出す。渡し済みの script は実行し直さない。
- 処理の途中で Local Bridge を閉じても、dev サーバーには分からない。
  その依頼は処理中のまま残り (`plugin.processing.elapsedSeconds` が伸び続ける)、次の依頼も待たせる。
  Local Bridge を開き直すと、前の項のとおりに依頼を受け取る。
- 終わらない script・プラグインを閉じる script (`figma.closePlugin()`)・`figma.ui.onmessage` を書き換える script を送ると、それ以降の依頼は処理されない。
  Local Bridge を閉じて開き直す。
- dev サーバーは使うときだけ起動する。
  localhost でだけ待ち受け、localhost 以外の名前で来た送信と、AI 側の口 (`/export`・`/run`・`/status`) への Origin 付きの送信 (ブラウザで開いたサイトからの送信) は断る。
  ただし Local Bridge の口は Figma のプラグインと同じ `Origin: null` を受ける。
  ブラウザで開いたサイトの sandbox の iframe から、依頼 (script のコードと合言葉を含む) を読み、結果を差し替えられる余地が残る (読んだ合言葉で `/run` は呼べない)。

## 未確認の前提 (Figma 実機での動作確認推奨)

- 終わらない script (同期の無限ループ) を送ったとき、Local Bridge を閉じて止められること
