# Structure Dump の書き出し (schema: dump-v2)

Figma プラグイン Structure Dump が書き出した ZIP の読み方。
AI (Claude Code 等) が最初に読む前提で書いている。

## 読む順番

1. `index.json` で、セクションと画面フレームの一覧を見る。
2. 実装する画面を 1 枚ずつ選び、その `.json` (構造) と `.png` (見た目) をセットで読む。
3. 画面の間の注記・矢印・小さい部品が要るときは、そのセクションの `_section.json` を読む。
4. 画像の中身が要るときは、ノードの `fills[].imageRef` を `index.json` の `assets` で引き、`assets/` のファイルのパスを得る。

ZIP 全体を一度に読み込む必要はない。
画面 1 枚ぶんの json と png を組で扱うのが最も精度が出る。

## ZIP の構成

```
README.md                            このファイル
index.json                           セクション → 画面フレームの一覧
<セクション>/<フレーム名>.<id>.png    画面フレームのスクリーンショット (1x)
<セクション>/<フレーム名>.<id>.json   その画面フレーム以下の構造
<セクション>/_section.json           FRAME でもセクションでもない子 (テキスト・矢印・インスタンスなど) の構造
<フレーム名>.<id>.png / .json         直接選ばれたノード・ページ直下のノード (ZIP 直下)
assets/<imageRef>.<拡張子>           image fill の元画像 (index.json の assets から引く)
```

- セクションのディレクトリ名は `<セクション名>.<id>`。
  ネストしたセクションはディレクトリもネストする (`Flow-A.1-2/Sub.3-4/...`)。
- 名前の中の空白・制御文字と `/ \ : * ? " < > |` は `-` に置き換え (連続は 1 つにまとめる)、40 字で切る。
  先頭の `.` は取る。
  最初の `.` より前が Windows の予約名 (`CON`・`PRN`・`AUX`・`NUL`・`COM1`〜`COM9`・`LPT1`〜`LPT9`) なら、先頭に `_` を付ける (`CON.notes` → `_CON.notes`)。
  空になった名前は `node` にする。
  id の `:` などは `-` に置き換える (`12:34` → `12-34`)。
  同名のフレームも id で区別されるので、ファイル名は衝突しない。
- パスは名前から作るので、ノードの特定には json 内の `id` を使う。

### 何が画面フレームになるか

判定は Figma のノードの型だけで決まり、大きさは見ない。

| 置き場所 | 型 | 扱い |
|---|---|---|
| セクション直下の子 | `FRAME` | 画面フレーム (png + json) |
| セクション直下の子 | `SECTION` | ネストしたセクション (ディレクトリ) |
| セクション直下の子 | それ以外 (`VECTOR`・`LINE`・`TEXT`・`GROUP`・`INSTANCE`・`COMPONENT` など) | そのセクションの `_section.json` |
| 直接選ばれたノード・未選択時のページ直下のノード | `SECTION` | セクション (ディレクトリ) |
| 直接選ばれたノード・未選択時のページ直下のノード | それ以外 (型とサイズを問わない) | ZIP 直下の画面フレーム (png + json) |

プラグインはデータを落とさないので、アイコンのような小さい `FRAME` も画面フレームとして出る。
画面でないものは読む側で除く (`width` / `height` や名前で見分ける)。

`_section.json` に入る子が無いセクションには `_section.json` が無い。
非表示のノードはどこにも出ない。
直接選ばれたノード (未選択時はページ直下のノード) が非表示で除かれたときは、`meta.warnings` に残る。

セクションの中のノードを、そのセクションを選ばずに直接選んだ場合も、ZIP 直下に置かれる。
このとき json の `section` は `null` になる。

## 座標

座標は 2 種類あり、画面フレームにもセクションにも付く。

- `x` / `y`: ノードの原点 (回転前の左上) の、Figma 上の親に対する相対座標。
  セクション直下の子ならセクション、ページ直下のノードならページに対する値になる。
  直接選ばれたノードの親は、出力に含まれないことがある (フレームの中の部品を選んだ場合など)。
- `absoluteX` / `absoluteY`: ノードの原点 (回転前の左上) のページ座標。
  回転したノードでも、外接矩形の左上ではない。
  そのため、ノード自身が回転していても「親の `absoluteX` + `x` = `absoluteX`」が成り立つ。
  親 (セクションなど) が回転している場合は、`x` / `y` が親の回転した座標系での値になるので、この式は成り立たない。

ここでの「親」は、GROUP と BOOLEAN_OPERATION を飛ばした外側の container (FRAME・COMPONENT・COMPONENT_SET・INSTANCE・SECTION・ページ) を指す (Figma の仕様)。
GROUP の子の `x` / `y` は GROUP ではなく外側の container に対する値なので、`group.x + child.x` のように足さない。

画面どうしの位置関係 (遷移の並び・矢印の向き先) を見るときは、絶対座標を比べる。

## index.json

```
{
  "meta": { "fileName", "pluginVersion", "schemaVersion": "dump-v2", "exportedAt", "scope", "warnings": [] },
  "sections": [ <セクション> ],
  "frames": [ <画面フレーム> ],
  "assets": { "<imageRef>": "assets/<imageRef>.<拡張子>" }
}
```

- `meta.scope`: `selection` (選択を書き出した) か `page:<ページ名>` (未選択でページ直下を書き出した)。
- `meta.warnings`: 次のものが 1 行ずつ入る。
  - 書き出し中に起きた失敗 (スクリーンショット失敗・空の PNG・画像の取得失敗・コンポーネント情報の読み取り失敗など)
  - 非表示のため除外したノード (`非表示のため除外: <name> (<id>)`)
  - ZIP 内パスが 200 文字を超えたもの (`パスが長い (N 文字): <path>`。展開先によってはパス長の上限に当たる)
- `sections`: トップレベルのセクション。document 順に並ぶ。
- `frames`: ZIP 直下に置いた画面フレーム (直接選ばれたノード・ページ直下のノード)。
- `assets`: ノードの `fills[].imageRef` → ZIP 内の画像ファイルのパス。
  書き出せた画像だけが入る。
  取得に失敗した imageRef はキーが無く、理由は `meta.warnings` にある。

セクションの形は次のとおり。

```
{ "id", "name", "dir", "x", "y", "absoluteX", "absoluteY", "width", "height",
  "frames": [ <画面フレーム> ], "sections": [ <ネストしたセクション> ],
  "sectionJson": "<dir>/_section.json" }
```

- `dir`: ZIP 内のディレクトリ (ZIP のルートからのパス)。
- `sectionJson`: `_section.json` のパス。`_section.json` が無いセクションではキーごと無い。

画面フレームの形は次のとおり。

```
{ "id", "name", "png", "json", "x", "y", "absoluteX", "absoluteY", "width", "height" }
```

- `png` / `json`: ZIP 内のパス。
- スクリーンショットに失敗したフレームには `png` キーが無い。
  理由は `meta.warnings` にある。

## 画面フレームの json

```
{
  "schemaVersion": "dump-v2",
  "section": { "id", "name", "dir" } | null,
  "absoluteX", "absoluteY",
  "node": <ノード>
}
```

- `section`: そのフレームを置いたセクションのディレクトリ。
  ZIP 直下のフレームでは、Figma 上でセクションの中にあっても `null`。
- `node`: 画面フレーム自身とその子孫 (下の「ノードの読み方」)。
  `node.x` / `node.y` は親 (上の「座標」の意味。GROUP は親にならない) に対する相対座標。

## _section.json

```
{
  "schemaVersion": "dump-v2",
  "section": { "id", "name", "dir", "x", "y", "absoluteX", "absoluteY", "width", "height" },
  "nodes": [ <ノード>, ... ]
}
```

- `nodes`: セクション直下の、画面フレームでもセクションでもない子。document 順に並ぶ。
  各ノードの `x` / `y` はセクションに対する相対座標。

## ノードの読み方

画面フレームの json の `node` と、`_section.json` の `nodes[]` は同じ形のノード。
子は `children[]` に入れ子で入る。

- デフォルト値と非表示ノードは出力されない。キーが無ければデフォルト値だと読む。
- `id` / `name` / `type` は必ずある。`type` は Figma のノード種別 (`FRAME`・`TEXT`・`INSTANCE` など)。
- `width` / `height`: サイズ。
- `layoutMode` / `padding: [上,右,下,左]` / `itemSpacing` / `layoutSizingHorizontal` / `layoutSizingVertical`: auto layout。
- `x` / `y` が付くかどうかは、`children[]` で直近の親 (GROUP を含む) が auto layout かで決まる。
  付くのは次のどれか。
  それ以外は auto layout が座標を決めるので出ない。
  - 画面フレームの json の `node` と、`_section.json` の `nodes[]` の各要素
  - 直近の親が auto layout でない子 (GROUP の子はこれに当たる)
  - `layoutPositioning: "ABSOLUTE"` の子
- `x` / `y` の値の基準は、付き方とは別に決まる。
  どの場合も「座標」の節でいう親 (GROUP と BOOLEAN_OPERATION を飛ばした外側の container) に対する相対座標。
  GROUP の子の `x` / `y` に GROUP の `x` / `y` を足さない。
- 色は `#rrggbb` に正規化済み。透明度は `opacity` / `alpha`。
- `componentName` / `componentSetName` / `props`: インスタンスの由来と variant。
  props のキーは Figma 内部キーの `#` 以降を取り除いた表示名 (`Label#12:34` → `Label`)。
- `variables`: ノードに束縛された Figma Variables の名前 (デザイントークン)。
- 書式が混在するテキストは `textSegments[]` に展開される。
- `fills[].imageRef`: image fill の元画像。`index.json` の `assets[imageRef]` が ZIP 内のファイルのパス。
  キーが無ければ画像の取得に失敗している (理由は `meta.warnings`)。
- `extractionError`: そのノードの情報を一部読めなかった理由。構造の出力は続いている。

## 実装に使うときのヒント

- `props` と `componentName` を、実装側のコンポーネントとの対応表として先に作ると安定する。
- スクリーンショットは見た目の確認用。寸法・色・余白は json の値を使う。
