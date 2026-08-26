# Structure Dump

Figma の構造をまるごと書き出すプラグイン。特定の UI ライブラリには依存しない。
選択したフレームの構造 JSON とスクリーンショットを 1 つの ZIP で書き出し、
AI (Claude Code 等) に渡してコーディングさせるための入力を作る。
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

1. 書き出したいフレームを選択する (未選択なら現在ページ全体が対象)
2. プラグイン「Structure Dump」を実行
3. 「ZIPをダウンロード」で保存し、展開してコーディング対象のリポジトリに置く
4. AI には `structure.json` と `screenshots/` を一緒に渡す

## ZIP の中身

```
structure.json          構造 JSON (schema: dump-v1)
screenshots/<フレーム名>.<ノードid>.png   トップレベル各ノードの見た目 (1x)
assets/<imageRef>.<拡張子>               image fill の元画像
```

- スクリーンショットは `structure.json` の `meta.screenshots[]` (id → file) で対応付く
- image fill は各ノードの `fills[].imageRef` と `assets/` のファイル名 (hash) で対応付く

## structure.json (dump-v1) の読み方

- デフォルト値と非表示ノードは出力されない。キーが無ければデフォルト値だと読む
- `layoutMode` / `padding: [上,右,下,左]` / `itemSpacing` / `layoutSizingHorizontal` /
  `layoutSizingVertical` … auto layout
- `x` / `y` が付くのは次のどちらかの子だけ。それ以外は auto layout が座標を決めるので出ない
  - 親が auto layout でない子
  - `layoutPositioning: "ABSOLUTE"` の子
- 色は `#rrggbb` に正規化済み。透明度は `opacity` / `alpha`
- `componentName` / `componentSetName` / `props` … インスタンスの由来と variant。
  props のキーは Figma 内部キーの `#` 以降を取り除いた表示名 (`Label#12:34` → `Label`)
- `variables` … ノードに束縛された Figma Variables の名前 (デザイントークン)
- 書式が混在するテキストは `textSegments[]` に展開される

## AI への渡し方のヒント

- 画面 1 枚ぶんの JSON + その screenshot をセットで渡すのが最も精度が出る
- 巨大なページ全体を一括で渡すより、フレーム単位で選択して書き出す方がよい
- `props` と `componentName` を実装側コンポーネントへの対応表として先に AI に示すと安定する

## 未確認の前提 (Figma 実機での動作確認推奨)

開発側で実機未実測の項目。コード上は失敗時の分岐やフォールバックで扱っている。

- `figma.ui.postMessage` で ZIP の `Uint8Array` が UI 側にそのまま届くこと
  (UI 側には届いた値を `new Uint8Array(...)` で包み直すフォールバックを実装済み)
- 巨大な選択 (数十 MB 級のスクリーンショット) での postMessage / メモリ挙動
- SECTION や GROUP を含め、どの種類のトップレベルノードでも `node.exportAsync` が
  成功すること (失敗は warning に落として続行する設計)

ZIP 生成と JSON 化のロジック自体は `tests/structure-dump-*.test.mts` で検証済み
(実物の ZIP リーダーで開ける・壊れたバイト列が CRC で落ちる・剪定規則)。
