# Structure Dump の書き出し (schema: dump-v3)

Figma プラグイン Structure Dump が書き出した ZIP の読み方。
AI (Claude Code 等) が最初に読む前提で書いている。

## 読む順番

1. `index.json` で、セクションと画面フレームの一覧を見る。
2. 実装する画面を 1 枚ずつ選び、その `.json` (構造) と `.png` (見た目) をセットで読む。
3. 画面の間の注記・矢印が要るときは、そのセクションの `_section.json` を読む。
   ただし `GROUP` にまとめた矢印や、部品の `INSTANCE` は、`_section.json` ではなく画面フレームとして `index.json` に載る (下の「何が画面フレームになるか」)。
4. 画像の中身が要るときは、ノードの `fills[].imageRef` を `index.json` の `assets` で引き、`assets/` のファイルのパスを得る。
   アイコンなどのベクターは、ノードの `svg` が `assets/svg/` の SVG ファイルを指す。
5. デザイントークンが要るときは、`variables.json` (Variables の全モードの値) と `styles.json` (名前付きスタイルの中身) を読む。
   ノードの `variables` と `styles` には名前が入っているので、それで引く。
   どちらも大きくなりやすい (数百 KB) ので、頭から全部は読まず、名前で検索して要る要素だけを読む (例: `jq '.collections[].variables[] | select(.name == "function/primary")' variables.json`)。

ZIP 全体を一度に読み込む必要はない。
画面 1 枚ぶんの json と png を組で扱うのが最も精度が出る。

## ZIP の構成

```
README.md                            このファイル
index.json                           セクション → 画面フレームの一覧
<セクション>/<フレーム名>.<id>.png    画面フレームのスクリーンショット (倍率は meta.screenshotScale)
<セクション>/<フレーム名>.<id>.json   その画面フレーム以下の構造
<セクション>/_section.json           画面フレームでもセクションでもない子 (テキスト・矢印など) の構造
<フレーム名>.<id>.png / .json         直接選ばれたノード・ページ直下のノード (ZIP 直下)
variables.json                       ファイル全体の Variables (コレクション・モード・全モードの値)
styles.json                          名前付きスタイル (ファイルのスタイルと、使われていたライブラリのスタイル)
assets/<imageRef>.<拡張子>           image fill の元画像 (index.json の assets から引く)
assets/svg/<id>.svg                  ベクターだけのノードの SVG (ノードの svg から引く)
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
| セクション直下の子 | `FRAME`・`INSTANCE`・`COMPONENT`・`GROUP` | 画面フレーム (png + json) |
| セクション直下の子 | `SECTION` | ネストしたセクション (ディレクトリ) |
| セクション直下の子 | それ以外 (`VECTOR`・`LINE`・`TEXT`・`COMPONENT_SET` など) | そのセクションの `_section.json` |
| 直接選ばれたノード・未選択時のページ直下のノード | `SECTION` | セクション (ディレクトリ) |
| 直接選ばれたノード・未選択時のページ直下のノード | それ以外 (型とサイズを問わない) | ZIP 直下の画面フレーム (png + json) |

プラグインはデータを落とさないので、アイコンのような小さい `FRAME` や部品の `INSTANCE`、矢印をまとめた `GROUP` も画面フレームとして出る。
画面でないものは読む側で除く (`index.json` の画面フレームの `type`・`componentSetName`・`width` / `height`・名前で見分ける)。

`_section.json` に入る子が無いセクションには `_section.json` が無い。
非表示のノードは出ない。
ただし、コンポーネントのプロパティで出し入れする子は、非表示でも `visible: false` を付けて構造に残る (下の「ノードの読み方」)。
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
  "meta": { "fileName", "pluginVersion", "schemaVersion": "dump-v3", "exportedAt", "scope", "screenshotScale", "warnings": [] },
  "sections": [ <セクション> ],
  "frames": [ <画面フレーム> ],
  "assets": { "<imageRef>": "assets/<imageRef>.<拡張子>" }
}
```

- `meta.scope`: `selection` (選択を書き出した)・`page:<ページ名>` (ページ直下を書き出した)・`nodes` (開発ループの依頼で id を指定したノードを書き出した) のどれか。
  `nodes` のときは、指定したノードが「直接選ばれたノード」と同じ扱いになる。
- `meta.screenshotScale`: スクリーンショットの倍率 (`2` か `1`)。
  png は画面フレームの枠で切って書き出すので、png のピクセル数は `width` / `height` にこの倍率を掛けた値になり、png の左上は枠の左上に当たる。
  座標を png のピクセルに当てるときは、座標にこの倍率を掛ける。
  枠の外にはみ出した描画 (横スクロールの続き・影など) は png に入らない。
  はみ出しがあったフレームは `meta.warnings` に出て、はみ出した部分のノードは json にある。
- `meta.warnings`: 次のものが 1 行ずつ入る。
  - 書き出し中に起きた失敗 (スクリーンショット失敗・空の PNG・画像の取得失敗・コンポーネント情報の読み取り失敗など)
  - 非表示のため除外したノード (`非表示のため除外: <name> (<id>)`)
  - ZIP 内パスが 200 文字を超えたもの (`パスが長い (N 文字): <path>`。展開先によってはパス長の上限に当たる)
  - 枠の外に描画があり、png を枠で切った画面フレーム (`枠の外に描画があり、png は枠で切った: <name> (<id>)`)
  - SVG の書き出しに失敗したノード (`SVG の書き出しに失敗: <name> (<id>): <理由>`)
  - 変数の値を解決できなかったもの (`変数の値を解決できない: <変数名>: <理由>`)
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
{ "id", "name", "type", "componentName", "componentSetName", "png", "json",
  "x", "y", "absoluteX", "absoluteY", "width", "height" }
```

- `type`: Figma のノード種別 (`FRAME`・`INSTANCE`・`COMPONENT`・`GROUP` など)。
- `componentName` / `componentSetName`: コンポーネントの名前とコンポーネントセットの名前。
  `INSTANCE` では元のコンポーネントの名前が `componentName` に、それが属するセットの名前が `componentSetName` に入る。
  セットの中の `COMPONENT` (バリアントの定義) を直接選んだときは、`componentSetName` だけが入る。
  配置した画面か定義かは `type` で見分ける。
  バリアントの `componentName` は `Property 1=Default` のような形なので、画面を名前で拾うときは `componentSetName` を見る。
  画面フレームの json の `node` にある同名のキーと同じ値で、そちらに無いときはここにも無い。
- `png` / `json`: ZIP 内のパス。
- スクリーンショットに失敗したフレームには `png` キーが無い。
  理由は `meta.warnings` にある。

## 画面フレームの json

```
{
  "schemaVersion": "dump-v3",
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
  "schemaVersion": "dump-v3",
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
- `visible: false`: コンポーネントのプロパティで出し入れする子が、いま非表示であること。
  どのプロパティで出し入れするかは `propertyRefs.visible` にある。
  プロパティと結び付いていない非表示の子は出ない。
- `width` / `height`: サイズ。`minWidth` / `maxWidth` / `minHeight` / `maxHeight`: auto layout の最小・最大の大きさ。
- `layoutMode` / `padding: [上,右,下,左]` / `itemSpacing` / `primaryAxisAlignItems` / `counterAxisAlignItems` / `layoutSizingHorizontal` / `layoutSizingVertical`: auto layout。
  折り返すときは `layoutWrap: "WRAP"` と `counterAxisSpacing` / `counterAxisAlignContent`。
  `strokesIncludedInLayout: true` は、枠線の太さをレイアウトの大きさに含める。
- `x` / `y` が付くかどうかは、`children[]` で直近の親 (GROUP を含む) が auto layout かで決まる。
  付くのは次のどれか。
  それ以外は auto layout が座標を決めるので出ない。
  - 画面フレームの json の `node` と、`_section.json` の `nodes[]` の各要素
  - 直近の親が auto layout でない子 (GROUP の子はこれに当たる)
  - `layoutPositioning: "ABSOLUTE"` の子
- `x` / `y` の値の基準は、付き方とは別に決まる。
  どの場合も「座標」の節でいう親 (GROUP と BOOLEAN_OPERATION を飛ばした外側の container) に対する相対座標。
  GROUP の子の `x` / `y` に GROUP の `x` / `y` を足さない。
- `constraints: { horizontal, vertical }`: `x` / `y` が付くノードの、親の大きさが変わったときの追従 (`MIN`・`MAX`・`CENTER`・`STRETCH`・`SCALE`)。
  既定の `MIN` / `MIN` (左上に固定) のときは出ない。
- 色は `#rrggbb` に正規化済み。透明度は `opacity` / `alpha`。
- `strokes` / `strokeWeight` / `strokeAlign`: 枠線。辺ごとに太さが違うときは `strokeWeight` の代わりに `strokeWeights: [上,右,下,左]`。
- `clipsContent: true`: はみ出した子を枠で切る。`overflowDirection`: スクロールする向き (`HORIZONTAL`・`VERTICAL`・`BOTH`)。
- `blendMode` (通常以外の合成)・`isMask: true` (マスク)・`booleanOperation` (BOOLEAN_OPERATION の種類)。
- `componentName` / `componentSetName` / `props`: インスタンスの由来と variant。
  props のキーは Figma 内部キーの `#` 以降を取り除いた表示名 (`Label#12:34` → `Label`)。
  INSTANCE_SWAP の props の値は、差し替え先のコンポーネントの id。
- `propertyRefs`: そのノードがコンポーネントのどのプロパティと結び付いているか。キーは結び付いた中身で、値はプロパティの表示名。
  - `visible`: このプロパティ (BOOLEAN) で表示を出し入れする。
  - `characters`: このプロパティ (TEXT) の値がテキストの中身になる。
  - `mainComponent`: このプロパティ (INSTANCE_SWAP) でインスタンスの中身を差し替える。
- `propertyDefinitions`: コンポーネントのプロパティの定義。表示名 → `{ type, default, options, description }`。
  `type` は `BOOLEAN`・`TEXT`・`INSTANCE_SWAP`・`VARIANT`。`options` は VARIANT の選択肢。
  INSTANCE_SWAP の `default` は `{ id, name }` (既定のコンポーネント)。
  付くのは `COMPONENT_SET`、セットに属さない `COMPONENT`、直接書き出したバリアント (`COMPONENT`。セットの定義を写す) の 3 つ。
  セットの中のバリアントには付かない (セット側を見る)。
  直接書き出したバリアントでも `default` はセットの既定値で、そのバリアント自身の値は `props` にある。
- `description`: コンポーネント (`COMPONENT` / `COMPONENT_SET`) の説明。
- `variables`: ノードに束縛された Figma Variables。束縛した項目 → `{ name, value }`。
  `value` はそのノードで効いているモードでの値 (色は `#rrggbb`、半透明は `#rrggbbaa`)。
  効いているモードは、ノードか祖先の `variableModes` で明示したモード。どこにも無ければコレクションの `defaultMode`。
  `fills` / `strokes` は paint ごとの配列、テキストの書式 (`fontSize`・`fontFamily` など) は文字の範囲ごとの配列。
  角丸は四隅ごと (`topLeftRadius` など) に入る。値を解決できなかった変数は `name` だけ。
  ほかのモードの値は `variables.json` を `name` で引く。
- `variableModes`: ノードに明示した Variables のモード。コレクション名 → モード名。
- `styles`: 名前付きスタイルの名前。`fill`・`stroke`・`text`・`effect`・`grid` → スタイル名。
  中身は `styles.json` を名前で引く。テキストの一部ずつ違うスタイルは `"mixed"` で、中身は `textSegments[]` にある。
- テキストは `characters` と書式 (`fontFamily`・`fontStyle`・`fontSize`・`fontWeight`・`lineHeight`・`letterSpacing` など)。
  `paragraphSpacing` / `paragraphIndent`: 段落の間と字下げ。
  `textTruncation: "ENDING"` と `maxLines`: 行数を超えたら末尾を省略する。
  `hyperlink: { type, value }`: リンク (`URL` なら URL、`NODE` ならノードの id)。
- 書式が部分ごとに違うテキストは `textSegments[]` に展開される。
  各要素は `text` と、その部分の書式・`fills`・`textStyle` / `fillStyle` (スタイル名)・`hyperlink`。
- `fills[].imageRef`: image fill の元画像。`index.json` の `assets[imageRef]` が ZIP 内のファイルのパス。
  キーが無ければ画像の取得に失敗している (理由は `meta.warnings`)。
- `svg`: ベクターだけでできたノード (アイコンなど) の SVG ファイルの ZIP 内パス。
  付くのは、子孫が図形だけ (テキストも画像も無い) で線を描く図形を含む部分木の、いちばん上のノードだけ。
  その子孫には付かない。長方形と楕円だけの枠には付かない。
  非表示の INSTANCE (`visible: false`) は Figma が書き出せないので、元のコンポーネントの SVG を指す (ファイル名は元のコンポーネントの id)。
  インスタンスで上書きした色や大きさはこの SVG に入らないので、json の `width` / `height` と子の `strokes` / `fills` を使う。
  INSTANCE 以外の非表示のノードには付かない。
  書き出しに失敗したノードにはキーが無い (理由は `meta.warnings`)。
- `annotations[]`: Dev Mode の注記。`label` (本文) と `properties` (注記に添えたプロパティの種類)。
- `extractionError`: そのノードの情報を一部読めなかった理由。構造の出力は続いている。

## variables.json

```
{
  "collections": [
    { "id", "name", "remote", "modes": ["Light", "Dark"], "defaultMode": "Light",
      "variables": [ { "id", "name", "type", "values": { "<モード名>": <値> }, "description", "scopes", "codeSyntax" } ] }
  ]
}
```

- ファイルのコレクションの全変数と、ノードが使っていたライブラリ (`remote: true`) の変数が入る。
  ファイルのコレクションには `remote` のキーが無い。
  ライブラリのコレクションには、使われていた変数だけが入る。
- `type`: `COLOR`・`FLOAT`・`STRING`・`BOOLEAN`。
- `values`: モード名 → 値。色は `#rrggbb` (半透明は `#rrggbbaa`)。
  別の変数を参照する値は `{ "alias": "<変数名>" }`。参照先の名前で引き直す。
  参照先は別のコレクションのことがあり、そのコレクションのモードが 1 つならその値、複数なら同じ名前のモードの値を読む。
- `scopes` / `codeSyntax`: Figma で設定した適用範囲とコードでの名前。設定が無ければキーが無い。

## styles.json

```
{ "styles": [ { "id", "name", "type", "remote", "description", ... } ] }
```

- ファイルの名前付きスタイルと、ノードが使っていたライブラリのスタイル (`remote: true`。ファイルのスタイルにはキーが無い)。
- `type` ごとの中身は、ノードと同じ書き方。
  - `PAINT`: `paints` (ノードの `fills` と同じ形)。
  - `TEXT`: `fontFamily`・`fontStyle`・`fontSize`・`lineHeight`・`letterSpacing` など。
  - `EFFECT`: `effects`。
  - `GRID`: `layoutGrids`。
- `variables`: スタイルに束縛された変数の名前 (`{ name }`)。スタイルはノードではないので値は無い。値は `variables.json` を名前で引く。

## 実装に使うときのヒント

- `props` と `componentName` を、実装側のコンポーネントとの対応表として先に作ると安定する。
- スクリーンショットは見た目の確認用。寸法・色・余白は json の値を使う。
