# figma-plugins

特定の UI ライブラリ・プロジェクトに依存しない汎用の Figma プラグイン集。
どちらも「Figma のデザインを AI (Claude 等) に渡せる形に書き出す」ためのプラグインで、
コード生成はしない (解釈とコード化は AI 側の仕事)。

| プラグイン | 用途 |
|---|---|
| [Structure Dump](plugins/structure-dump/) | 選択フレームの構造 JSON + スクリーンショットを 1 つの ZIP で書き出す |
| [Component Spec](plugins/component-spec/) | 選択中のコンポーネント群から variant / props の仕様 JSON を書き出す |

## セットアップ

```sh
npm install
npm run build        # 両方ビルド (個別: build:dump / build:spec)
```

Figma デスクトップアプリで: Plugins → Development → Import plugin from manifest…
→ 各プラグインの `manifest.json` を選択。

- `plugins/structure-dump/manifest.json`
- `plugins/component-spec/manifest.json`

使い方は各プラグインの README を参照。

## 構成

```
plugins/structure-dump/   構造 JSON + スクリーンショットの ZIP 書き出し
plugins/component-spec/   variant / props の仕様書き出し
shared/nodeOrder.ts       走査順の固定 (両プラグインで共有)
```

- どちらのプラグインも `networkAccess: none` (外部送信なし)。ZIP は自前の無圧縮実装
  (`plugins/structure-dump/src/zip.ts`) で生成する
- JSON の組み立ては Figma API 非依存の純関数に分離してある
  (`serialize.ts` / `spec.ts` / `nodeOrder.ts`)

## 開発

```sh
npm run typecheck    # tsc --noEmit
```

ビルド生成物 (`plugins/*/dist/`) はコミットしない。Figma に読み込む前に必ずビルドする。

## License

[MIT](LICENSE)
