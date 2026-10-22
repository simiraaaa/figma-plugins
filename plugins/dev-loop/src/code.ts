/**
 * Dev Loop - plugin main
 *
 * dev サーバー (npm run dev:server) につなぎ、AI が送った依頼をこのファイルで実行して結果を返す開発用プラグイン。
 * 依頼は 2 種類: Structure Dump と同じ書き出し (POST /export) と、Plugin API の script の実行 (POST /run)。
 * 書き出しは Structure Dump の dump() を build で取り込むので、Structure Dump から書き出したものと同じ出力になる。
 * 配らない (リリースの zip に入れない)。
 */

import {
  currentPageTarget,
  dump,
  DumpTarget,
  failureText,
} from "../../structure-dump/src/dump";
import { DEFAULT_SCREENSHOT_SCALE } from "../../structure-dump/src/plan";
import { runScript } from "./run";

interface DevRequest {
  seq: number;
  nodeIds?: string[];
  scale?: number;
}

/** 依頼の id を書き出し対象にする。PAGE の id を 1 つだけ渡したら、そのページ直下を書き出す */
async function devTarget(nodeIds: readonly string[] | undefined): Promise<DumpTarget> {
  if (nodeIds === undefined) return currentPageTarget();
  const nodes: SceneNode[] = [];
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node === null) throw new Error(`ノードが見つからない: ${id}`);
    if (node.type === "PAGE") {
      if (nodeIds.length !== 1) throw new Error(`ページの id は単独で指定する: ${id}`);
      await node.loadAsync();
      return { roots: node.children, source: "page", scope: `page:${node.name}` };
    }
    if (node.type === "DOCUMENT") throw new Error(`ドキュメントは指定できない: ${id}`);
    nodes.push(node);
  }
  return { roots: nodes, source: "nodes", scope: "nodes" };
}

interface DevRunRequest {
  seq: number;
  code: string;
  token: string;
}

type DevMessage =
  | { type: "dev-request"; request: DevRequest }
  | { type: "run-request"; request: DevRunRequest }
  | { type: "dev-token"; token: string };

/** script の実行の合言葉。ホットリロードやファイルをまたいで同じ値を使えるよう、clientStorage に残す */
const RUN_TOKEN_KEY = "devRunToken";

/**
 * UI が dev サーバーから依頼を long-poll で取り、ここへ 1 件ずつ渡す。
 * 結果は UI がサーバーへ POST する (ネットワークに出られるのは UI の iframe だけ)
 */
async function runDevLoop(): Promise<void> {
  figma.showUI(__html__, { width: 480, height: 600 });
  const stored: unknown = await figma.clientStorage.getAsync(RUN_TOKEN_KEY);
  let runToken = typeof stored === "string" ? stored : undefined;
  figma.ui.onmessage = async (msg: DevMessage) => {
    if (msg.type === "dev-token") {
      runToken = msg.token;
      await figma.clientStorage.setAsync(RUN_TOKEN_KEY, msg.token);
      return;
    }
    if (msg.type === "run-request") {
      const { seq, code, token } = msg.request;
      const body = await runScript({ code, token, expectedToken: runToken, api: figma });
      figma.ui.postMessage({ type: "run-result", seq, body });
      return;
    }
    if (msg.type !== "dev-request") return;
    const request = msg.request;
    try {
      const outcome = await dump(
        await devTarget(request.nodeIds),
        request.scale ?? DEFAULT_SCREENSHOT_SCALE
      );
      if (outcome.type === "empty") {
        figma.ui.postMessage({ type: "dev-error", seq: request.seq, message: outcome.message });
      } else {
        figma.ui.postMessage({ type: "dev-result", seq: request.seq, payload: outcome.payload });
      }
    } catch (err) {
      figma.ui.postMessage({ type: "dev-error", seq: request.seq, message: failureText(err) });
    }
  };
  // 合言葉がまだ無ければ、UI が作って dev-token で送り返す
  figma.ui.postMessage({ type: "dev-start", token: runToken });
}

runDevLoop().catch((err: unknown) => {
  figma.ui.postMessage({ type: "error", message: `${failureText(err)}\n開発ループを始められませんでした` });
});
