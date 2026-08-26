# figma-plugins

汎用の Figma プラグイン集。特定の UI ライブラリやプロジェクトには依存しない。
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

ビルドすると各プラグインの `dist/code.js` が生成される。生成物はコミットしないので、
clone 直後や pull 直後は必ずビルドしてから Figma に読み込む。

## Figma への取り込み (共通手順)

どちらのプラグインも手順は同じ。

1. **Figma デスクトップアプリ**を用意する (ブラウザ版では開発プラグインを読み込めない。
   未インストールなら https://www.figma.com/downloads/ から)
2. このリポジトリを移動・削除しない場所に置き、上のセットアップでビルドしておく
   (Figma はプラグインを実行するたびに、インポート時に指定した場所の manifest.json と
   ビルド生成物を読み直す。リポジトリを動かすと壊れる)
3. Figma で任意のデザインファイルを開く
4. メニュー → **Plugins** → **Development** → **Import plugin from manifest…**
   (日本語 UI では: **プラグイン** → **開発** → **マニフェストからプラグインをインポート…**)
5. 読み込みたいプラグインの `manifest.json` を選択する
   - Structure Dump: `plugins/structure-dump/manifest.json`
   - Component Spec: `plugins/component-spec/manifest.json`

インポートは初回のみ。以降はどのデザインファイルでも Plugins → Development 配下から実行でき、
コードを更新したときは再ビルドすれば次の実行から反映される (再インポート不要)。

使い方は各プラグインの README を参照。

## 構成

```
plugins/structure-dump/   構造 JSON + スクリーンショットの ZIP 書き出し
plugins/component-spec/   variant / props の仕様書き出し
shared/nodeOrder.ts       複数ノードを選択したときの出力順を、選択順でなく
                          document 上の並び順に固定する (両プラグインで共有)
```

- どちらのプラグインも `networkAccess: none` (外部送信なし)。ZIP は圧縮なし (stored) の
  ZIP 形式で、外部ライブラリを使わない自前実装 (`plugins/structure-dump/src/zip.ts`) で生成する
- JSON の組み立ては Figma API 非依存の純関数に分離してある
  (`serialize.ts` / `spec.ts` / `nodeOrder.ts`)

## 開発

```sh
npm test             # node --test (Figma API 非依存の純関数を検査)
npm run typecheck    # tsc --noEmit (プラグイン本体とテストの両方)
```

## 配布 (GitHub Releases)

npm を使わない人に配るときは、[Releases](https://github.com/simiraaaa/figma-plugins/releases)
の zip (`structure-dump-plugin.zip` / `component-spec-plugin.zip`) を渡す。
zip は manifest.json + ビルド済み code.js + ui.html の 3 点セット。
受け取り側の手順は [component-spec の INSTALL.md](plugins/component-spec/INSTALL.md) を参照
(structure-dump も同じ手順。フォルダ名を読み替える)。

リリースの作成 (メンテナ向け):

```sh
npm run release               # test → build → zip 組み立て → gh release create
npm run release -- --dry-run  # zip 組み立てまでで止める (公開しない)
```

package.json の `version` から tag (`v<version>`) を作る。各プラグインの
`PLUGIN_VERSION` と version がずれていると中断する。CI (GitHub Actions) は使わず、
実行は手元で gh CLI の認証で行う。

ビルド生成物 (`plugins/*/dist/`) はコミットしない。Figma に読み込む前に必ずビルドする。

## License

[MIT](LICENSE)
