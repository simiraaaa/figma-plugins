/**
 * Component Spec - plugin main
 *
 * 選択中のコンポーネント群から variant / props の仕様 JSON を書き出す。
 * リストの粒度は ComponentSet 単位で、仕様の正は componentPropertyDefinitions。
 * 並んでいるインスタンスは examples (確認済みパターンの証跡) として添える。
 *
 * このファイルは figma グローバルに触る層。JSON の組み立ては ./spec に置く。
 */

import { sortInDocumentOrder } from "../../../shared/nodeOrder";
import { buildZip, utf8Encode, ZipEntry } from "../../structure-dump/src/zip";
import {
  buildSpecDocument,
  GroupSummary,
  RawExample,
  RawGroup,
  RawPropertyDefinition,
  RawPropertyValue,
  safeName,
  screenshotPath,
  summarizeGroup,
} from "./spec";

const PLUGIN_VERSION = "0.2.0";
const SCREENSHOT_SCALE = 1;

type SpecTarget = InstanceNode | ComponentNode | ComponentSetNode;
type DefinitionSource = ComponentNode | ComponentSetNode;

interface ScannedExample {
  readonly node: SpecTarget;
  readonly raw: RawExample;
}

interface ScannedGroup {
  readonly key: string;
  readonly name: string;
  readonly componentSetId?: string;
  readonly definitions: Record<string, RawPropertyDefinition> | null;
  readonly definitionsError?: string;
  readonly examples: ScannedExample[];
}

let scannedGroups: ScannedGroup[] = [];
let scanWarnings: string[] = [];
/** selectionchange 連打で古い非同期スキャンの結果が後から上書きするのを防ぐ */
let scanToken = 0;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

/**
 * 選択ツリーから INSTANCE / COMPONENT / COMPONENT_SET を集める。
 * インスタンスと単体コンポーネントの内部は辿らない (入れ子のアイコン等でリストが埋まるため)
 */
function collectTargets(node: SceneNode, out: SpecTarget[], seen: Set<string>): void {
  if (node.visible === false) return;

  if (node.type === "INSTANCE" || node.type === "COMPONENT") {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      out.push(node);
    }
    return;
  }

  if (node.type === "COMPONENT_SET" && !seen.has(node.id)) {
    seen.add(node.id);
    out.push(node);
  }

  if ("children" in node) {
    for (const child of node.children) collectTargets(child, out, seen);
  }
}

interface DefinitionsRead {
  readonly definitions: Record<string, RawPropertyDefinition> | null;
  readonly error?: string;
}

/**
 * componentPropertyDefinitions は variant の ComponentNode や remote 参照で例外になりうる。
 * 中止せず null を返し、呼び出し側で examples 集約へフォールバックさせる
 */
function readDefinitions(node: DefinitionSource): DefinitionsRead {
  try {
    const defs = node.componentPropertyDefinitions as
      | Record<string, RawPropertyDefinition>
      | undefined;
    return { definitions: defs ?? null };
  } catch (e) {
    return { definitions: null, error: message(e) };
  }
}

function exampleFromInstance(node: InstanceNode): RawExample {
  try {
    const props = node.componentProperties as
      | Readonly<Record<string, RawPropertyValue>>
      | null
      | undefined;
    return { nodeId: node.id, name: node.name, properties: props ?? null };
  } catch (e) {
    return {
      nodeId: node.id,
      name: node.name,
      properties: null,
      extractionError: message(e),
    };
  }
}

function exampleFromComponent(node: ComponentNode): RawExample {
  try {
    const variants = node.variantProperties;
    if (!variants) return { nodeId: node.id, name: node.name, properties: {} };
    const properties: Record<string, RawPropertyValue> = {};
    for (const [key, value] of Object.entries(variants)) {
      properties[key] = { type: "VARIANT", value };
    }
    return { nodeId: node.id, name: node.name, properties };
  } catch (e) {
    return {
      nodeId: node.id,
      name: node.name,
      properties: null,
      extractionError: message(e),
    };
  }
}

function ensureGroup(
  groups: Map<string, ScannedGroup>,
  key: string,
  name: string,
  componentSetId: string | undefined,
  definitionSource: DefinitionSource | null
): ScannedGroup {
  const existing = groups.get(key);
  if (existing) return existing;

  const read: DefinitionsRead = definitionSource
    ? readDefinitions(definitionSource)
    : { definitions: null };
  const group: ScannedGroup = {
    key,
    name,
    componentSetId,
    definitions: read.definitions,
    definitionsError: read.error,
    examples: [],
  };
  groups.set(key, group);
  return group;
}

/** remote / soft-deleted の main component は parent を持たないことがある */
function parentComponentSet(node: ComponentNode): ComponentSetNode | null {
  try {
    const parent = node.parent;
    return parent !== null && parent.type === "COMPONENT_SET" ? parent : null;
  } catch (e) {
    return null;
  }
}

async function scan(): Promise<void> {
  const token = (scanToken += 1);
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    scannedGroups = [];
    scanWarnings = [];
    figma.ui.postMessage({ type: "empty" });
    return;
  }

  const targets: SpecTarget[] = [];
  const seen = new Set<string>();
  for (const root of sortInDocumentOrder(selection)) {
    collectTargets(root, targets, seen);
  }

  const groups = new Map<string, ScannedGroup>();
  const warnings: string[] = [];

  for (const node of targets) {
    if (node.type === "COMPONENT_SET") {
      ensureGroup(groups, node.id, node.name, node.id, node);
      continue;
    }

    if (node.type === "COMPONENT") {
      const set = parentComponentSet(node);
      const group = set
        ? ensureGroup(groups, set.id, set.name, set.id, set)
        : ensureGroup(groups, node.id, node.name, undefined, node);
      group.examples.push({ node, raw: exampleFromComponent(node) });
      continue;
    }

    let main: ComponentNode | null = null;
    try {
      main = await node.getMainComponentAsync();
    } catch (e) {
      warnings.push(`main component の取得に失敗: ${node.name} (${node.id}): ${message(e)}`);
    }

    let group: ScannedGroup;
    if (main) {
      const set = parentComponentSet(main);
      group = set
        ? ensureGroup(groups, set.id, set.name, set.id, set)
        : ensureGroup(groups, main.id, main.name, undefined, main);
    } else {
      // main を辿れない (remote / soft-deleted)。インスタンス名でまとめ、examples から集約する
      group = ensureGroup(groups, `name:${node.name}`, node.name, undefined, null);
      warnings.push(
        `main component を辿れないためインスタンス名でグループ化: ${node.name} (${node.id})`
      );
    }
    group.examples.push({ node, raw: exampleFromInstance(node) });
  }

  if (token !== scanToken) return;

  scannedGroups = Array.from(groups.values());
  scanWarnings = warnings;

  const summaries: GroupSummary[] = scannedGroups.map((group) => summarizeGroup(toRawGroup(group)));
  figma.ui.postMessage({
    type: "list",
    groups: summaries,
    warnings,
    selectionCount: selection.length,
  });
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

function toRawGroup(group: ScannedGroup): RawGroup {
  return {
    key: group.key,
    name: group.name,
    componentSetId: group.componentSetId,
    definitions: group.definitions,
    definitionsError: group.definitionsError,
    examples: group.examples.map((example) => example.raw),
  };
}

async function exportSpec(keys: readonly string[], includeScreenshots: boolean): Promise<void> {
  const selected = scannedGroups.filter((group) => keys.indexOf(group.key) !== -1);
  if (selected.length === 0) {
    figma.ui.postMessage({ type: "error", message: "対象が選ばれていません" });
    return;
  }

  const warnings = scanWarnings.slice();
  const entries: ZipEntry[] = [];
  const screenshots: Record<string, string> = {};

  if (includeScreenshots) {
    for (const group of selected) {
      for (const example of group.examples) {
        const node = example.node;
        if (node.removed) {
          warnings.push(`ノードが削除済みのためスクリーンショットを省略: ${example.raw.name}`);
          continue;
        }
        const file = screenshotPath(group.name, node.name, node.id);
        try {
          const bytes = await node.exportAsync({
            format: "PNG",
            constraint: { type: "SCALE", value: SCREENSHOT_SCALE },
          });
          entries.push({ name: file, data: bytes });
          screenshots[node.id] = file;
        } catch (e) {
          warnings.push(
            `スクリーンショット失敗: ${node.name} (${node.id}): ${message(e)}`
          );
        }
      }
    }
  }

  const specDocument = buildSpecDocument({
    meta: {
      fileName: figma.root.name,
      pluginVersion: PLUGIN_VERSION,
      exportedAt: new Date().toISOString(),
    },
    groups: selected.map(toRawGroup),
    screenshots,
    warnings,
  });
  const jsonText = JSON.stringify(specDocument, null, 2);

  const meta = {
    componentCount: specDocument.components.length,
    exampleCount: specDocument.components.reduce((sum, c) => sum + c.examples.length, 0),
    screenshotCount: Object.keys(screenshots).length,
    warnings: specDocument.meta.warnings,
  };

  if (!includeScreenshots) {
    figma.ui.postMessage({ type: "json", payload: { jsonText, meta } });
    return;
  }

  entries.unshift({ name: "spec.json", data: utf8Encode(jsonText) });
  const zip = buildZip(entries);
  figma.ui.postMessage({
    type: "zip",
    payload: {
      zipName: `${safeName(figma.root.name)}-component-spec.zip`,
      zip,
      meta: { ...meta, zipBytes: zip.length },
    },
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * 想定外の例外を UI へ届く診断へ畳む。裸で投げると unhandled rejection になり
 * UI が無言で止まる
 */
function reportFailure(err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  figma.ui.postMessage({ type: "error", message: `${detail}\n処理を中止しました` });
}

interface UiMessage {
  readonly type: string;
  readonly keys?: readonly string[];
}

async function run(): Promise<void> {
  figma.showUI(__html__, { width: 480, height: 620 });

  figma.ui.onmessage = (msg: UiMessage) => {
    if (!msg) return;
    if (msg.type === "export-json") {
      exportSpec(msg.keys ?? [], false).catch(reportFailure);
      return;
    }
    if (msg.type === "export-zip") {
      exportSpec(msg.keys ?? [], true).catch(reportFailure);
    }
  };

  figma.on("selectionchange", () => {
    scan().catch(reportFailure);
  });

  await scan();
}

run().catch(reportFailure);
