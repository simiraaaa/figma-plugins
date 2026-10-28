/**
 * Local Bridge の dev サーバー。使い方は plugins/local-bridge/README.md。
 *
 *   npm run dev:server                       # 受けた結果は .dev-dump/ に置く
 *   npm run dev:server -- --out <ディレクトリ>
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { createDevServer, DEV_PORTS, listenOnCandidatePorts, notStartedMessage } from "./dev-server-lib.mts";
import { checkRepoUpdate, mergeRepoUpdate, type RepoUpdate, UPDATE_CHECK_INTERVAL_MS, updateMessage } from "./update-check.mts";

const { values } = parseArgs({
  options: { out: { type: "string", default: ".dev-dump" } },
});
const outDir = path.resolve(values.out as string);
const root = path.resolve(import.meta.dirname, "..");
const log = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);

/** リポジトリに新しい版があるかの最新の確かめ。起動時と、動いているあいだ一定の間隔で確かめ直す */
let repoUpdate: RepoUpdate | null = null;

/** 新しい版があれば端末に出す (Local Bridge の画面には GET /hello で伝わる)。確かめられなかったときは理由だけ出し、前に分かっていた結果を残す */
async function refreshRepoUpdate(): Promise<void> {
  const checked = await checkRepoUpdate(root);
  repoUpdate = mergeRepoUpdate(repoUpdate, checked);
  const message = updateMessage(checked);
  if (message !== null) log(message);
  else if (checked.kind === "unknown") log(`リポジトリの新しい版を確かめられない: ${checked.reason}`);
}

const handler = createDevServer({ outDir, root, repoUpdate: () => repoUpdate, log });

// localhost が IPv4 と IPv6 のどちらに解決されても届くよう両方で受ける。
// LAN へは開かない (依頼を受けると Figma の中身を書き出し、script を実行するため)
const outcome = await listenOnCandidatePorts(handler, DEV_PORTS, ["127.0.0.1", "::1"]);
if (outcome.kind !== "listening") {
  console.error(notStartedMessage(outcome));
  process.exit(1);
}
outcome.errors.forEach((e) => console.error(`待ち受けられない: ${e}`));
if (outcome.servers.length === 0) process.exit(1);
if (outcome.busy.length > 0) {
  console.log(`ポート ${outcome.busy.join("・")} はほかのアプリが使っているので、次の候補で起動した`);
}
console.log(`dev サーバー: http://localhost:${outcome.port} (結果は ${outDir}/latest)`);

// 起動を待たせないよう、新しい版の確かめは待ち受けを始めてから行う (待ち受けている限りプロセスは動き続けるので、タイマーが終了を妨げることはない)
void refreshRepoUpdate();
setInterval(() => void refreshRepoUpdate(), UPDATE_CHECK_INTERVAL_MS);
