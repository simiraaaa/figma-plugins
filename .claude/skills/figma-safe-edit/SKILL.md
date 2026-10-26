---
name: figma-safe-edit
description: Local Bridge の /run で Figma のファイルを書き換えるときの手順。書き換える前と後を書き出して比べ、意図しない変化があれば Figma の取り消し (Cmd+Z と同じ) で戻す。Local Bridge の「AI に渡す文」がこのファイルを指しているとき、Figma を書き換える script を送る前に読む。読み取りだけの script には要らない。
---

# Figma を安全に書き換える

Local Bridge の /run で Figma を書き換えるときに従う。
Local Bridge 自体の使い方は `<リポ>/plugins/local-bridge/README.md` にある。

- `<リポ>`: この SKILL.md のパスから `.claude/skills/figma-safe-edit/SKILL.md` を除いたディレクトリ。
- `<URL>`: Local Bridge の画面からコピーした文にある dev サーバー (例: `http://localhost:47717`)。
- `<合言葉>`: 同じ文にある `X-Run-Token` の値。

## 始める前に

- 書き換えるファイルの名前を人に確かめる。
- `return figma.root.name;` を 3 回送り、3 回とも同じ名前が返ることを確かめる。
  違う名前が混じったら、Local Bridge が 2 つ以上のファイルで開いていて、依頼がどちらに届くか決まらない。
  書き換えずに、人に Local Bridge を 1 つだけにしてもらう。
- 書き換えて確かめ終わるまで、同じファイルを手で触らないよう人に頼む。
  人が手で書き換えると、戻すときにそちらが先に戻る。

## 1. 書き換える前を書き出す

書き換えるノードをすべて含む、いちばん小さいノードの id を決める。
ノードを足す・消すなら、その親にする。

```sh
curl -s -X POST '<URL>/export?timeout=110' -d '{"nodeIds":["<id>"]}'
```

応答の `dir` を before として控える。
大きいノードで時間が掛かるときの待ち方は、README の「使い方」の 3 にある。

## 2. 書き換える

script は次の形にする。

```js
if (figma.root.name !== "<ファイル名>") throw new Error("別のファイル: " + figma.root.name);
figma.commitUndo();
// ここで書き換える
figma.commitUndo();
return "<確かめたい値>";
```

- 頭と終わりの `figma.commitUndo()` で、この script の書き換えが取り消しの 1 手になる。
  無いと、前に送った script の書き換えと 1 手にまとまり、戻すときに一緒に戻る。
- 書き換えは 1 つの script にまとめる。
  2 つ以上に分けるなら、script ごとに 1〜3 を回す。
- HTTP 422 が返ったときの扱いは、README の「script の実行」に従う。

## 3. 後を書き出して比べる

1 と同じ curl で書き出し、応答の `dir` を after として控える。

```sh
npm --prefix <リポ> run -s compare -- <before> <after>
```

出力の JSON の欄は次のとおり。

- `same`: 変わったところが無ければ `true`
- `changed`・`added`・`removed`: 変わった・足された・消えたファイル
- `images`: 画面の画像ごとの、色が違う画素の数
- `changesDiff`: 構造の差分 (`diff -u`) を書いたファイル
- `report`: before・after・差分の画像 (色が違う画素を赤くしたもの) と構造の差分を並べた HTML

`changesDiff` を読み、変化を 3 つに分ける。

- 意図した変化: 頼まれたとおりか確かめる。無いか違っていれば、問題として 4 に進む。
- 自分の script が起こした、意図していない変化: 問題として 4 に進む。
- 自分の script で説明できない変化: 同じファイルを別の人が編集していると、その人の変化も差分に出る。
  自分のものと決めず、4 にも進まずに、人に確かめる。

見た目の良し悪しは判定しない。
`open <report>` で report を開き、人に見て判断してもらう。

比べた結果が思いがけず `same: false` のときは、先に書き出しの応答の `warnings` を見る。
画面がスリープしているあいだの書き出しは、警告つきで欠けることがある。
普段は出ない警告があれば、人に画面を起こしてもらい、書き出し直して比べ直す。

## 4. 問題があれば戻す

戻すのは、Figma の取り消し (Cmd+Z と同じ) で行う。
値を書き戻す script は使わない。

1. もう一度書き出し、その `dir` を now とする。
   `compare -- <after> <now>` の `same` が `true` であることを確かめる。
   `false` なら、書き換えのあとに誰かが触っている。
   取り消すとそちらが先に戻るので、取り消さずに人に伝える。
2. 取り消しを 1 回だけ送る。

   ```js
   if (figma.root.name !== "<ファイル名>") throw new Error("別のファイル: " + figma.root.name);
   figma.triggerUndo();
   ```

3. もう一度書き出し、その `dir` を reverted とする。
   `compare -- <before> <reverted>` の `same` が `true` なら、戻せた。
   `false` なら、3 の終わりのとおり、書き出しの欠けでないかを先に確かめる。
   欠けでなければ、取り消しが別の書き換えを戻している。
   `triggerUndo` はもう送らず、人に「Figma のそのファイルで Cmd+Shift+Z を 1 回押して」と頼む (間違って戻したものが元に戻る)。
   押してもらったら書き出し、`compare -- <now> <その書き出し>` の `same` が `true` なら、取り消す前の状態に戻っている。

`triggerUndo` を、1 の確かめなしに送らない。続けて送らない。
取り消しの履歴には、人が手でした書き換えや、何日も前の書き換えも入っていて、余分に送るとそれが戻る。

## 終わったら

比べた結果は書き出しの置き場所の下の `compare/` に残る。
人に report の場所を伝える。
