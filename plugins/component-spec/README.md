# Component Spec

選択中のコンポーネント群から variant / props の仕様を JSON に書き出す Figma プラグイン。
デザイナーが手打ち・音声入力で AI に伝えていた「このコンポーネントはこういう variant がある」を
そのまま貼れる形にするのが用途 (Claude に貼る / 仕様書に起こす)。

[Structure Dump](../structure-dump/) の兄弟プラグイン。構造まるごとの書き出しは structure-dump、
コンポーネントの仕様 (取りうるプロパティと値) はこちらが担当する。
`shared/nodeOrder.ts` (走査順の固定) と `plugins/structure-dump/src/zip.ts` (無圧縮 ZIP) を共有している。

## セットアップ

```sh
npm install        # リポルートで (未実施なら)
npm run build:spec
```

Figma デスクトップアプリで: Plugins → Development → Import plugin from manifest…
→ `plugins/component-spec/manifest.json` を選択。

配布用の詳しいインストール手順 (非開発者向け) は [INSTALL.md](INSTALL.md) を参照。

## 使い方

1. 仕様を書き出したいコンポーネントを含むフレームを選択する (未選択だと何も出ない。ページ全体の走査はしない)
2. プラグイン「Component Spec」を実行
3. ComponentSet 単位のリストから対象をチェックする (既定は全チェック。全選択 / 全解除あり)
4. 「JSON をコピー」で Claude に貼る、または「ZIP を DL」で `spec.json` + スクリーンショットを保存する

プラグインを開いたまま Figma 側で別のフレームを選び直すと、リストが自動で作り直される。

### 走査の規則

- 選択ツリーの INSTANCE / COMPONENT / COMPONENT_SET を検出する
- リストの粒度は ComponentSet 単位。set に属さない単独 COMPONENT はそのコンポーネント単位
- インスタンスと単独コンポーネントの**内部は辿らない** (入れ子のアイコン等でリストが埋まるため)
- 非表示 (`visible: false`) のノードは対象外

## 出力 (schema: component-spec-v1)

```jsonc
{
  "meta": { "fileName": "...", "pluginVersion": "0.1.0", "schemaVersion": "component-spec-v1",
            "exportedAt": "...", "warnings": [] },
  "components": [
    {
      "name": "Input type=password",       // ComponentSet 名 (無ければコンポーネント名)
      "componentSetId": "10:0",            // set が無い / 辿れない場合は無し
      "source": "definitions",             // "definitions" | "examples" (下記)
      "properties": {                      // 取りうる全プロパティ
        "State":       { "type": "VARIANT", "defaultValue": "Default",
                         "values": ["Default", "Hover", "Focus", "Error"] },
        "ShowToggle":  { "type": "BOOLEAN", "defaultValue": true, "description": "表示切替アイコン" },
        "Label":       { "type": "TEXT",    "defaultValue": "パスワード" }
      },
      "examples": [                        // ドキュメント順。確認済みパターンの証跡
        { "nodeId": "20:1", "name": "State=Default",
          "props": { "State": "Default", "ShowToggle": true },
          "screenshot": "screenshots/Input-type=password/State=Default.20-1.png" }
      ]
    }
  ]
}
```

- `properties` の正は `componentPropertyDefinitions`。並んでいるインスタンスから逆算はしない
- キーは Figma 内部 id サフィックス (`Label#12:34`) を落とした表示名。落とした結果衝突したら warning
- `type` は Figma API の値そのまま (`VARIANT` / `BOOLEAN` / `TEXT` / `INSTANCE_SWAP` / `SLOT`)。
  真偽値は `BOOL` ではなく `BOOLEAN`
- `values` は VARIANT だけに付く (TEXT の実値は候補値ではないので出さない。中身は `examples` を見る)
- `description` は Figma 側でプロパティに説明が書かれているときだけ付く
- `screenshot` は ZIP 出力のときだけ付く (JSON コピーには入らない)

ZIP の中身:

```
spec.json
screenshots/<ComponentSet 名>/<バリアント名>.<ノードid>.png
```

## remote コンポーネント時のフォールバック (`source`)

ライブラリ (別ファイル) 発の remote コンポーネントや soft-deleted なコンポーネントでは、
`instance.getMainComponentAsync()` で得た main が **parent を持たないことがある**
(Figma の型定義にも明記されている)。また variant の ComponentNode に対する
`componentPropertyDefinitions` は例外になりうる。この場合 ComponentSet や定義まで辿れない。

- 辿れた場合: `source: "definitions"`。`properties` は定義そのまま (デフォルト値と全 variant 値つき)
- 辿れない場合: `source: "examples"`。選択中の各インスタンスの `componentProperties` から
  propName → 出現値を集約する。**観測できた値だけ**なので取りうる全値の保証は無い。
  デフォルト値は分からないので出さない (捏造しない)
- main そのものが辿れない場合は**インスタンス名でグループ化**する (名前を変えられた
  インスタンスは別グループに割れる)。この場合 warning が出る

どちらの経路でも、読み取り失敗は中止せず `meta.warnings` に記録して続行する
(壊れた ComponentSet = variant 重複などでも書き出しは止まらない)。

## 未確認の前提 (Figma 実機での動作確認推奨)

remote コンポーネントを含むファイルを手元に用意できないため、以下は未実測。
コード上は分岐と `source` / warnings で明示的に扱っている。

- remote コンポーネントで `main.parent` が null になる / `componentPropertyDefinitions` が
  例外になる、の実際の組み合わせ (どちらの経路でフォールバックに入るか)
- remote インスタンスの `componentProperties` に `type` が入って返るか
  (入らない場合は値から `BOOLEAN` / `TEXT` を推定する保険が働く)
- variant の ComponentNode に対する `componentPropertyDefinitions` が例外か空か
- `figma.on("selectionchange")` 連打時のリスト追従 (古い非同期スキャンは token で破棄する実装)
- `figma.ui.postMessage` で ZIP の `Uint8Array` が UI 側にそのまま届くこと
  (UI 側は `new Uint8Array(...)` で包み直すフォールバックあり)
- プラグイン iframe での `document.execCommand("copy")` の可否
  (失敗時は `navigator.clipboard` → 手動コピー用 textarea へ段階的に落とす)
