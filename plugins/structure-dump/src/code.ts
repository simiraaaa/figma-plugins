/**
 * Structure Dump - plugin main
 *
 * 特定の UI ライブラリに依存しない汎用の構造書き出しプラグイン。
 * 選択ノード (未選択なら現在ページ直下) をセクション単位・画面フレーム単位に分け、
 * 画面フレームごとの構造 JSON とスクリーンショット PNG、image fill の元画像、
 * 読み方の README を 1 つの ZIP (無圧縮) に束ねて UI へ渡す。コード生成はしない (AI 側の仕事)。
 */

import { currentPageTarget, dump, failureText } from "./dump";
import { screenshotScaleFor } from "./plan";

async function run(): Promise<void> {
  figma.showUI(__html__, { width: 480, height: 600 });
  const outcome = await dump(currentPageTarget(), screenshotScaleFor(figma.command));
  if (outcome.type === "empty") {
    figma.ui.postMessage({ type: "error", message: outcome.message });
  } else {
    figma.ui.postMessage(outcome);
  }
}

/**
 * 想定外の例外を UI へ届く診断へ畳む。裸の run() だと unhandled rejection になり
 * UI が「実行中」のまま無言で止まる
 */
run().catch((err: unknown) => {
  figma.ui.postMessage({
    type: "error",
    message: `${failureText(err)}\n書き出しを中止しました`,
  });
});
