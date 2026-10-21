/**
 * Structure Dump の開発用サーバー。使い方は plugins/structure-dump/README.md の「開発ループ」。
 *
 *   npm run dev:server                       # 受けた結果は .dev-dump/ に置く
 *   npm run dev:server -- --out <ディレクトリ>
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { createDevServer, DEV_PORTS, listenOnCandidatePorts, notStartedMessage } from "./dev-server-lib.mts";

const { values } = parseArgs({
  options: { out: { type: "string", default: ".dev-dump" } },
});
const outDir = path.resolve(values.out as string);

const handler = createDevServer({
  outDir,
  log: (line) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`),
});

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
