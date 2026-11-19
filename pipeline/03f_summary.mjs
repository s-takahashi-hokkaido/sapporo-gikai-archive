#!/usr/bin/env node
// 工程3 T6: 本会議（T4）と委員会（T5）のまとまりを合わせて数え、出力をまたいで確かめる。何も書き出さない。
// 設計: docs/工程3の設計.md の「工程3 全体の結果（T6）」
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/03f_summary.mjs
//
// 工程3をすべて流し直すときの順番: 03a_speeches → 03b_toc → 03c_members → 03d_plenary → 03e_committee → 03f_summary
//
// 入力: data/struct/speeches/<年>.jsonl（T1）、data/struct/exchanges/<年>-k1,k2,k3.jsonl（T4・T5）
// 確かめること（0件でなければ見直す）:
// - まとまりの id が重なっていない。id が最初の発言の HUID で、出典の url がその HUID を指している
// - 1つの発言が2つのまとまりに入っていない（本会議と委員会をまたいでも）
// - まとまりの発言が、すべて発言の層（speeches）にあり、同じ会議のもの
// - 質問者のいるまとまりに会派がある
// ◆と◎で、どのまとまりにも入っていないものは（確認用）として出す。委員会で、委員長の進行とみた記号の付け間違い（T5 の「記号と役職が合わない」）だけのはず

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STRUCT = path.join(here, "..", "data", "struct");
const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bodyOf = (sp) => sp.text.slice(sp.head?.length ?? 0).replace(/^[\s　]+/, "");
const quantile = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];

async function main() {
  const speeches = new Map();
  for (const f of (await readdir(path.join(STRUCT, "speeches"))).filter((f) => /^\d{4}\.jsonl$/.test(f)).sort())
    for (const s of await readJsonl(path.join(STRUCT, "speeches", f))) speeches.set(s.huid, s);

  const exs = [];
  const files = (await readdir(path.join(STRUCT, "exchanges"))).filter((f) => /^\d{4}-k[123]\.jsonl$/.test(f)).sort();
  for (const f of files) for (const e of await readJsonl(path.join(STRUCT, "exchanges", f))) exs.push(e);

  const report = { dupId: [], badId: [], dupHuid: [], missing: [], noFaction: [], uncovered: [] };
  const ids = new Set();
  const owner = new Map();
  for (const e of exs) {
    if (ids.has(e.id)) report.dupId.push(`${e.file} ${e.id}`);
    ids.add(e.id);
    if (e.id !== e.huids[0] || !e.url?.includes(`HUID=${e.id}&`)) report.badId.push(`${e.file} ${e.id}: huids[0]=${e.huids[0]}`);
    for (const h of e.huids) {
      if (owner.has(h)) report.dupHuid.push(`HUID${h}: ${owner.get(h)} と ${e.id}`);
      owner.set(h, e.id);
      const s = speeches.get(h);
      if (!s || s.file !== e.file) report.missing.push(`${e.file} ${e.id}: HUID${h} が${s ? `別の会議（${s.file}）` : "発言の層にない"}`);
    }
    if (e.questioner && !e.faction) report.noFaction.push(`${e.file} ${e.id} ${e.type} ${e.questioner}`);
  }
  for (const s of speeches.values())
    if ((s.mark === "◆" || s.mark === "◎") && !owner.has(s.huid)) report.uncovered.push(`${s.file} HUID${s.huid} ${s.head}: ${bodyOf(s).slice(0, 30).replace(/\n/g, "⏎")}`);

  // 件数と字数。「種類」は本会議・委員会で同じ名前（代表質問は本会議だけ）
  const rows = new Map();
  for (const e of exs) {
    const k = `${e.kind}\t${e.type}`;
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(e.chars);
  }
  const days = new Set(exs.map((e) => e.file));
  console.log(`まとまり ${exs.length} 件（${files.length} ファイル、会議 ${days.size} 日分）。発言 ${speeches.size} 件のうち ${owner.size} 件がどれかのまとまりに入っている（残りは議長・委員長の進行など）`);
  console.log("\n会議の種類 × まとまりの種類: 件数 / 字数の合計 / 中央値 / 9割 / 最大");
  const total = { n: 0, chars: 0 };
  for (const [k, a] of [...rows].sort()) {
    a.sort((x, y) => x - y);
    const sum = a.reduce((x, y) => x + y, 0);
    total.n += a.length;
    total.chars += sum;
    console.log(`  ${k.replace("\t", " × ")}: ${a.length} 件 / ${sum.toLocaleString()} 字 / ${quantile(a, 0.5)} / ${quantile(a, 0.9)} / ${a[a.length - 1]}`);
  }
  console.log(`  合計: ${total.n} 件 / ${total.chars.toLocaleString()} 字`);
  // 工程5（分類・要約）で読む候補: 「その他」以外
  const read = exs.filter((e) => e.type !== "その他");
  console.log(`\n工程5で読む候補（「その他」を除く）: ${read.length} 件 / ${read.reduce((x, e) => x + e.chars, 0).toLocaleString()} 字（議長・委員長の進行の発言を含む）`);

  const byTerm = {};
  for (const e of exs) byTerm[e.term] = (byTerm[e.term] ?? 0) + 1;
  console.log(`任期ごとのまとまり: ${Object.entries(byTerm).sort().map(([k, v]) => `${k} ${v}`).join("、")}`);
  console.log("");

  const checks = [
    ["まとまりの id が重なっている", report.dupId],
    ["id が最初の発言の HUID でない、または url がその HUID を指していない", report.badId],
    ["1つの発言が2つのまとまりに入っている", report.dupHuid],
    ["まとまりの発言が発言の層にない、または別の会議のもの", report.missing],
    ["会派が空の質問者", report.noFaction],
    ["（確認用）◆か◎で、どのまとまりにも入っていない（委員会で委員長の進行とみた記号の付け間違いのはず）", report.uncovered],
  ];
  for (const [label, l] of checks) {
    console.log(`${label}: ${l.length} 件`);
    for (const x of l.slice(0, 20)) console.log(`  ${x}`);
    if (l.length > 20) console.log(`  ほか ${l.length - 20} 件`);
  }
  if (report.dupId.length || report.badId.length || report.dupHuid.length || report.missing.length || report.noFaction.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`エラー: ${err.stack ?? err.message}`);
  process.exit(1);
});
