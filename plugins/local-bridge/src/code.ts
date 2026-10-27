/**
 * Local Bridge - plugin main
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
import { DEFAULT_SCREENSHOT_SCALE, ImagesMode, parseImagesMode } from "../../structure-dump/src/plan";
import { RunResultBody, runScript, wrongFileReason } from "./run";

interface DevRequest {
  seq: number;
  /** 行き先のファイル。このファイルの figma.fileKey と違えば処理しない */
  fileKey?: string;
  nodeIds?: string[];
  scale?: number;
  /** 省略は both。dev サーバーが 3 値以外を断るが、届いたら書き出さずに dev-error で返す */
  images?: ImagesMode;
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
  fileKey?: string;
  code: string;
  token: string;
}

type DevMessage =
  | { type: "dev-request"; request: DevRequest }
  | { type: "run-request"; request: DevRunRequest }
  | { type: "dev-token"; token: string }
  | { type: "ui-compact"; compact: boolean };

/** script の実行の合言葉。ホットリロードやファイルをまたいで同じ値を使えるよう、clientStorage に残す */
const RUN_TOKEN_KEY = "devRunToken";
/** 小さくしたかは残さず、開くたびに広げた大きさで始める */
const UI_SIZE = { width: 480, height: 600 };
const UI_COMPACT_SIZE = { width: 200, height: 32 };

/**
 * UI が dev サーバーから依頼を long-poll で取り、ここへ 1 件ずつ渡す。
 * 結果は UI がサーバーへ POST する (ネットワークに出られるのは UI の iframe だけ)
 */
async function runLocalBridge(): Promise<void> {
  figma.showUI(__html__, UI_SIZE);
  // dev サーバーは依頼をファイル (fileKey) ごとに振り分けるので、自分のファイルを名乗れなければつながない。
  // 開発用プラグインの figma.fileKey は、manifest の enablePrivatePluginApi が無いと取れない
  const fileKey = figma.fileKey;
  if (typeof fileKey !== "string" || fileKey === "") {
    figma.ui.postMessage({
      type: "error",
      message:
        "このファイルの fileKey が取れないので、dev サーバーにつながない。\n" +
        "Figma で プラグイン → 開発 → マニフェストからプラグインをインポート… から plugins/local-bridge/manifest.json を取り込み直し、Local Bridge を開き直す",
    });
    return;
  }
  const stored: unknown = await figma.clientStorage.getAsync(RUN_TOKEN_KEY);
  let runToken = typeof stored === "string" ? stored : undefined;
  figma.ui.onmessage = async (msg: DevMessage) => {
    if (msg.type === "ui-compact") {
      const size = msg.compact ? UI_COMPACT_SIZE : UI_SIZE;
      figma.ui.resize(size.width, size.height);
      return;
    }
    if (msg.type === "dev-token") {
      runToken = msg.token;
      await figma.clientStorage.setAsync(RUN_TOKEN_KEY, msg.token);
      return;
    }
    if (msg.type === "run-request") {
      const { seq, code, token } = msg.request;
      const wrongFile = wrongFileReason(msg.request.fileKey, fileKey);
      const body =
        wrongFile === undefined
          ? await runScript({ code, token, expectedToken: runToken, api: figma })
          : JSON.stringify({ ok: false, error: wrongFile } satisfies RunResultBody);
      figma.ui.postMessage({ type: "run-result", seq, body });
      return;
    }
    if (msg.type !== "dev-request") return;
    const request = msg.request;
    const wrongFile = wrongFileReason(request.fileKey, fileKey);
    if (wrongFile !== undefined) {
      figma.ui.postMessage({ type: "dev-error", seq: request.seq, message: wrongFile });
      return;
    }
    const images = parseImagesMode(request.images);
    if (images === null) {
      figma.ui.postMessage({
        type: "dev-error",
        seq: request.seq,
        message: `images は "both"・"none"・"only" のどれかにする (届いた値: ${JSON.stringify(request.images)})`,
      });
      return;
    }
    try {
      const outcome = await dump(
        await devTarget(request.nodeIds),
        request.scale ?? DEFAULT_SCREENSHOT_SCALE,
        images
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
  figma.ui.postMessage({ type: "dev-start", token: runToken, fileKey, fileName: figma.root.name });
}

runLocalBridge().catch((err: unknown) => {
  figma.ui.postMessage({ type: "error", message: `${failureText(err)}\nLocal Bridge を始められませんでした` });
});
