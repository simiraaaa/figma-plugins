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
2. プラグイン「Structure Dump」を実行
3. 「ZIPをダウンロード」で保存し、展開してコーディング対象のリポジトリに置く
4. AI には展開したフォルダを渡し、まず `README.md` を読ませる

## ZIP の中身 (schema: dump-v2)

```
README.md                            読み方 (index.json と各 json のルール)
index.json                           セクション → 画面フレームの一覧 (id・名前・サイズ・座標)
<セクション>/<フレーム名>.<id>.png    画面フレームのスクリーンショット (1x)
<セクション>/<フレーム名>.<id>.json   その画面フレーム以下の構造
<セクション>/_section.json           画面フレーム以外の子 (メモ・矢印・小さいフレームなど) の構造
assets/<imageRef>.<拡張子>           image fill の元画像
```

- 画面フレームは、セクション直下の子のうち幅 380 以上かつ高さ 700 以上のもの。
  セクションの外で選んだノード (未選択時はページ直下のノード) は、SECTION 以外ならサイズに
  関係なく画面フレームとして ZIP 直下に置く
- ネストしたセクションはディレクトリもネストする
- JSON の各キーとノードの読み方は ZIP 内の `README.md` に書いてある。正本は
  [`src/zip-readme.md`](src/zip-readme.md) で、ビルド時に code.js へ埋め込まれる
  (esbuild の `--loader:.md=text`)

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
- SECTION とその子の `absoluteBoundingBox` がページ全体の絶対座標を返すこと
  (null のときは `absoluteTransform` の平行移動成分で代用する)
- セクション内のノードを、そのセクションを選ばずに直接選んだときも ZIP 直下に置く挙動が
  使い勝手として妥当か

計画 (どのノードをどのパスへ出すか) と JSON 化、ZIP 生成のロジック自体は
`tests/structure-dump-*.test.mts` で検証済み (画面フレームのしきい値・ネストしたディレクトリ・
重複選択の除去・index.json の形・実物の ZIP リーダーで開ける・壊れたバイト列が CRC で落ちる・
剪定規則)。
