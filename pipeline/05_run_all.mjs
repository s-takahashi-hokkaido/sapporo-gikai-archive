#!/usr/bin/env node
// 工程5: 05_classify.mjs --year を全部の年について流す。年ごとに別のバッチで同時に送り、終わったら失敗の残る年だけもう一度流す。
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/05_run_all.mjs                     # 2007〜2026年。API のキーは .env から（05_classify.mjs に --env-file=.env を渡す）
//   node pipeline/05_run_all.mjs --from 2023 --to 2026 --retries 2
//
// - 同時に流すのは --parallel 件まで（既定 10）。各年の様子は data/classify/logs/<年>.log
// - 記録済みのまとまりは 05_classify.mjs が飛ばすので、何度流してもよい。止めても続きから流せる
// - 最後に、年ごとの記録・項目なし・失敗の件数と料金の目安をまとめて出す

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const LOGS = path.join(ROOT, "data", "classify", "logs");

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? Number(argv[argv.indexOf(k) + 1]) : d);
const from = opt("--from", 2007), to = opt("--to", 2026), parallel = opt("--parallel", 10), retries = opt("--retries", 1);
const years = Array.from({ length: to - from + 1 }, (_, i) => from + i);
const lineCount = async (p) => (existsSync(p) ? (await readFile(p, "utf8")).split("\n").filter(Boolean).length : 0);

function runYear(y, round) {
  return new Promise((resolve) => {
    const log = createWriteStream(path.join(LOGS, `${y}.log`), { flags: "a" });
    log.write(`\n===== ${new Date().toISOString()} ${round === 0 ? "1回目" : `送り直し ${round}回目`} =====\n`);
    const p = spawn(process.execPath, ["--max-old-space-size=4000", "--env-file=.env", path.join(here, "05_classify.mjs"), "--year", String(y)], { cwd: ROOT });
    let out = "";
    p.stdout.on("data", (d) => ((out += d), log.write(d)));
    p.stderr.on("data", (d) => log.write(d));
    p.on("close", (code) => {
      log.end();
      const cost = Number(out.match(/料金の目安: \$([\d.]+)/)?.[1] ?? 0);
      const fail = Number(out.match(/失敗: (\d+)件/)?.[1] ?? (code === 0 ? 0 : NaN));
      console.log(`${new Date().toLocaleTimeString("ja-JP")} ${y}年 ${round === 0 ? "" : `（送り直し${round}）`}終了 code=${code} ${out.match(/記録した: [^\n]*/)?.[0] ?? ""} 失敗 ${fail}件 $${cost.toFixed(2)}`);
      resolve({ y, code, cost, fail });
    });
  });
}

async function pool(list, round) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, list.length) }, async () => {
      while (i < list.length) results.push(await runYear(list[i++], round));
    }),
  );
  return results;
}

async function main() {
  await mkdir(LOGS, { recursive: true });
  let total = 0;
  let todo = years;
  for (let round = 0; round <= retries && todo.length; round++) {
    console.log(`${round === 0 ? "流す" : "送り直す"}: ${todo.join(" ")}`);
    const res = await pool(todo, round);
    total += res.reduce((a, r) => a + r.cost, 0);
    todo = res.filter((r) => r.code !== 0 || r.fail > 0).map((r) => r.y).sort();
  }
  console.log("\n年 | 項目 | 項目なし | 失敗");
  let items = 0, empty = 0, errs = 0;
  for (const y of years) {
    const [a, b, c] = await Promise.all([
      lineCount(path.join(ROOT, "records", `${y}.jsonl`)),
      lineCount(path.join(ROOT, "records", "empty", `${y}.jsonl`)),
      lineCount(path.join(ROOT, "records", "errors", `${y}.jsonl`)),
    ]);
    (items += a), (empty += b), (errs += c);
    console.log(`${y} | ${a} | ${b} | ${c}`);
  }
  console.log(`計 | ${items} | ${empty} | ${errs}`);
  console.log(`料金の目安（今回流した分）: $${total.toFixed(2)}`);
  if (todo.length) console.log(`失敗の残る年: ${todo.join(" ")}（もう一度 node pipeline/05_run_all.mjs で送り直す）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
