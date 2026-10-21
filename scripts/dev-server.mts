/**
 * Structure Dump の開発用サーバー。使い方は plugins/structure-dump/README.md の「開発ループ」。
 *
 *   npm run dev:server                       # 受けた結果は .dev-dump/ に置く
 *   npm run dev:server -- --out <ディレクトリ>
 */
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { createDevServer, DEV_PORT, portInUseMessage } from "./dev-server-lib.mts";

const { values } = parseArgs({
  options: { out: { type: "string", default: ".dev-dump" } },
});
const outDir = path.resolve(values.out as string);

const handler = createDevServer({
  outDir,
  log: (line) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`),
});

// localhost が IPv4 と IPv6 のどちらに解決されても届くよう両方で受ける。
// LAN へは開かない (依頼を受けると Figma の中身を書き出すため)
let listening = 0;
let reportedInUse = false;
for (const host of ["127.0.0.1", "::1"]) {
  const server = http.createServer(handler);
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      if (reportedInUse) return;
      reportedInUse = true;
      // localhost に聞くと、もう片方のアドレスで待ち受けた自分に届きうるので、使用中だったアドレスに聞く
      const inUse = host.includes(":") ? `[${host}]` : host;
      void portInUseMessage(`http://${inUse}:${DEV_PORT}`).then((message) => {
        console.error(`ポート ${DEV_PORT} は使用中で起動できない。${message}`);
        process.exit(1);
      });
      return;
    }
    console.error(`${host} で待ち受けられない: ${e.message}`);
  });
  server.listen(DEV_PORT, host, () => {
    listening += 1;
    if (listening === 1) {
      console.log(`dev サーバー: http://localhost:${DEV_PORT} (結果は ${outDir}/latest)`);
    }
  });
}
