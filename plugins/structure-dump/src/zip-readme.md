# Structure Dump の書き出し (schema: dump-v2)

Figma プラグイン Structure Dump が書き出した ZIP の読み方。
AI (Claude Code 等) が最初に読む前提で書いている。

## 読む順番

1. `index.json` で、セクションと画面フレームの一覧を見る。
2. 実装する画面を 1 枚ずつ選び、その `.json` (構造) と `.png` (見た目) をセットで読む。
3. 画面の間の注記・矢印・小さい部品が要るときは、そのセクションの `_section.json` を読む。
4. 画像の中身が要るときは、ノードの `fills[].imageRef` から `assets/` のファイルを引く。

ZIP 全体を一度に読み込む必要はない。
画面 1 枚ぶんの json と png を組で扱うのが最も精度が出る。

## ZIP の構成

```
README.md                            このファイル
index.json                           セクション → 画面フレームの一覧
<セクション>/<フレーム名>.<id>.png    画面フレームのスクリーンショット (1x)
<セクション>/<フレーム名>.<id>.json   その画面フレーム以下の構造
<セクション>/_section.json           画面フレーム以外の子 (メモ・矢印・小さいフレームなど) の構造
<フレーム名>.<id>.png / .json         セクションの外の画面フレーム (ZIP 直下)
assets/<imageRef>.<拡張子>           image fill の元画像
```

- セクションのディレクトリ名は `<セクション名>.<id>`。
  ネストしたセクションはディレクトリもネストする (`Flow-A.1-2/Sub.3-4/...`)。
- 名前の中の空白と `/ \ : * ? " < > |` は `-` に置き換え (連続は 1 つにまとめる)、40 字で切る。
  id の `:` などは `-` に置き換える (`12:34` → `12-34`)。
  同名のフレームも id で区別されるので、ファイル名は衝突しない。
- パスは名前から作るので、ノードの特定には json 内の `id` を使う。

### 何が画面フレームになるか

- セクション直下の子のうち、幅 380 以上かつ高さ 700 以上のもの。
- セクションの外で直接選ばれたノードと、未選択で書き出したときのページ直下のノード
  (SECTION 以外。サイズは問わない)。

セクション直下の子のうち画面フレームに当たらないものは、
そのセクションの `_section.json` にまとめて入る。
該当する子が無いセクションには `_section.json` が無い。
非表示のノードはどこにも出ない。

## 座標

座標は 2 種類あり、画面フレームにもセクションにも付く。

- `x` / `y`: 親 (セクションまたはページ) に対する相対座標。
- `absoluteX` / `absoluteY`: ページ全体での絶対座標。

画面どうしの位置関係 (遷移の並び・矢印の向き先) を見るときは絶対座標を比べる。

## index.json

```
{
  "meta": { "fileName", "pluginVersion", "schemaVersion": "dump-v2", "exportedAt", "scope", "warnings": [] },
  "sections": [ <セクション> ],
  "frames": [ <画面フレーム> ]
}
```

- `meta.scope`: `selection` (選択を書き出した) か `page:<ページ名>` (未選択でページ直下を書き出した)。
- `meta.warnings`: 書き出し中に起きた失敗 (スクリーンショット失敗・画像の取得失敗など)。
- `sections`: トップレベルのセクション。document 順に並ぶ。
- `frames`: ZIP 直下に置いた画面フレーム (セクションの外のもの)。

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

- `section`: そのフレームが入っているセクション。ZIP 直下のフレームでは `null`。
- `node`: 画面フレーム自身とその子孫 (下の「ノードの読み方」)。
  `node.x` / `node.y` は親に対する相対座標。

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
- `x` / `y` が付くのは次のどれか。
  それ以外は auto layout が座標を決めるので出ない。
  - 画面フレームの json の `node` と、`_section.json` の `nodes[]` の各要素 (親に対する相対座標)
  - 親が auto layout でない子
  - `layoutPositioning: "ABSOLUTE"` の子
- 色は `#rrggbb` に正規化済み。透明度は `opacity` / `alpha`。
- `componentName` / `componentSetName` / `props`: インスタンスの由来と variant。
  props のキーは Figma 内部キーの `#` 以降を取り除いた表示名 (`Label#12:34` → `Label`)。
- `variables`: ノードに束縛された Figma Variables の名前 (デザイントークン)。
- 書式が混在するテキストは `textSegments[]` に展開される。
- `fills[].imageRef`: image fill の元画像。`assets/<imageRef>.<拡張子>` と対応する。
- `extractionError`: そのノードの情報を一部読めなかった理由。構造の出力は続いている。

## 実装に使うときのヒント

- `props` と `componentName` を、実装側のコンポーネントとの対応表として先に作ると安定する。
- スクリーンショットは見た目の確認用。寸法・色・余白は json の値を使う。
