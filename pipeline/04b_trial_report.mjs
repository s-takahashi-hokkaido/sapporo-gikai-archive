#!/usr/bin/env node
// 工程4 手順3: 試行（05_classify.mjs --trial）の結果を集計し、話題の一覧を直す手がかりを出す。
// 作り方: docs/作り方.md の工程4
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/04b_trial_report.mjs [--model claude-opus-5-5]   （モデルを省くと claude-opus-5-5）
//
// 入力: data/topics/trial/<モデル>/records.jsonl、errors.jsonl（05_classify.mjs --trial）、data/struct/speeches/<年>.jsonl、pipeline/topics.csv
// 出力: data/topics/trial/<モデル>/report.md
// 見るところ:
// - 「その他」に入った項目（まとまった数があるものは話題に足す）
// - 主の話題で迷った組み合わせ（主と迷った話題が入れ替わるものは、分け目を書き足すか、話題をまとめる）
// - 項目が1つもない話題（範囲が狭すぎるか、名前が伝わっていない）
// - 原文に見つからない数字・引用（工程8の照合の前ぶれ。多ければ指示書を直す）

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const MODEL = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "claude-opus-5-5";
const DIR = path.join(ROOT, "data", "topics", "trial", MODEL);
const readJsonl = async (p) => (existsSync(p) ? (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const count = (arr, key) => {
  const m = new Map();
  for (const x of arr) {
    const k = key(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
};
// 数字・引用の照合用。全角の数字と記号を半角に、空白と改行を外す
const norm = (s) =>
  s
    .replace(/[０-９Ａ-Ｚａ-ｚ．，％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, "");

async function main() {
  const recs = await readJsonl(path.join(DIR, "records.jsonl"));
  const errs = await readJsonl(path.join(DIR, "errors.jsonl"));
  if (!recs.length) throw new Error(`試行の記録がない（${DIR}）。先に node pipeline/05_classify.mjs --trial --model ${MODEL} を流す`);
  const topics = parseCsv(await readFile(path.join(here, "topics.csv"), "utf8"));
  const era = (r) => (r.date < "2015" ? "旧" : "新");

  const sp = new Map();
  for (const y of new Set(recs.map((r) => r.date.slice(0, 4))))
    for (const s of await readJsonl(path.join(ROOT, "data", "struct", "speeches", `${y}.jsonl`))) sp.set(s.huid, norm(s.text));

  const md = ["# 工程4 試行の結果", "", "`node pipeline/04b_trial_report.mjs` で作る。", ""];
  const exs = new Set(recs.map((r) => r.exchange));
  md.push(`まとまり ${exs.size}件 → 項目 ${recs.length}件。失敗 ${errs.length}件（${count(errs, (e) => e.reason).map(([k, n]) => `${k} ${n}`).join("、") || "なし"}）。`, "");

  md.push("## 1つのまとまりあたりの項目数", "");
  for (const [t, n] of count([...exs].map((id) => recs.find((r) => r.exchange === id)), (r) => `${r.committee_type ?? r.kind} ${r.type}`)) {
    const ids = [...exs].filter((id) => {
      const r = recs.find((x) => x.exchange === id);
      return `${r.committee_type ?? r.kind} ${r.type}` === t;
    });
    const items = recs.filter((r) => ids.includes(r.exchange)).length;
    md.push(`- ${t}: ${n}件、平均 ${(items / n).toFixed(1)}項目`);
  }

  md.push("", "## 主の話題ごとの件数", "", "| 話題 | 分野 | 旧（〜2010） | 新（2023〜） | 計 | 副として |", "|---|---|---|---|---|---|");
  for (const t of topics) {
    const name = t["話題"];
    const rs = recs.filter((r) => r.topic === name);
    const sub = recs.filter((r) => r.sub_topics.includes(name)).length;
    md.push(`| ${name} | ${t["分野"]} | ${rs.filter((r) => era(r) === "旧").length} | ${rs.filter((r) => era(r) === "新").length} | ${rs.length} | ${sub} |`);
  }
  const zero = topics.filter((t) => !recs.some((r) => r.topic === t["話題"] || r.sub_topics.includes(t["話題"])));
  md.push("", `主にも副にも1件もない話題: ${zero.map((t) => t["話題"]).join("、") || "なし"}`);

  md.push("", "## 「その他」に入った項目", "");
  for (const r of recs.filter((r) => r.topic === "その他")) md.push(`- ${r.date} ${r.committee ?? r.type}: **${r.title}** — ${r.question.slice(0, 80)}`);

  md.push("", "## 主の話題で迷った組み合わせ", "", "「主 ← 迷った話題」。両方向に出るものは、分け目を書き足すか、まとめるかを考える。", "");
  const pairs = count(recs.filter((r) => r.topic_alternative !== "なし"), (r) => `${r.topic} ← ${r.topic_alternative}`);
  md.push(`迷った項目: ${recs.filter((r) => r.topic_alternative !== "なし").length}件 / ${recs.length}件`, "");
  for (const [k, n] of pairs.slice(0, 40)) {
    const [a, b] = k.split(" ← ");
    const rev = pairs.find(([kk]) => kk === `${b} ← ${a}`)?.[1] ?? 0;
    const ex = recs.filter((r) => r.topic === a && r.topic_alternative === b).slice(0, 3).map((r) => r.title);
    md.push(`- ${k}: ${n}件${rev ? `（逆向き ${rev}件）` : ""} — ${ex.join("／")}`);
  }

  md.push("", "## 副の話題の組み合わせ（上位30）", "");
  const subPairs = count(recs.flatMap((r) => r.sub_topics.map((s) => ({ ...r, s }))), (r) => `${r.topic} ＋ ${r.s}`);
  for (const [k, n] of subPairs.slice(0, 30)) md.push(`- ${k}: ${n}件`);
  md.push("", `副の話題の数: ${count(recs, (r) => r.sub_topics.length).sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}個 ${n}件`).join("、")}`);

  md.push("", "## 地域", "");
  md.push(count(recs.flatMap((r) => r.areas), (a) => a).map(([k, n]) => `${k} ${n}`).join("、"));
  md.push("", `地名の例: ${[...new Set(recs.flatMap((r) => r.places))].slice(0, 60).join("、")}`);

  md.push("", "## 原文に見つからない数字・引用", "", "全角・半角と空白の違いは無視して、項目の発言の中に同じ文字列があるかを見る。", "");
  let nNum = 0, nQuote = 0;
  const missNum = [], missQuote = [];
  for (const r of recs) {
    const text = r.huids.map((h) => sp.get(h) ?? "").join("");
    for (const x of r.numbers) {
      nNum++;
      if (!(sp.get(x.huid) ?? text).includes(norm(x.value)) && !text.includes(norm(x.value))) missNum.push(`${r.id} ${x.value}（${x.meaning}）`);
    }
    for (const x of r.commitments) {
      nQuote++;
      if (!(sp.get(x.huid) ?? "").includes(norm(x.quote)) && !text.includes(norm(x.quote))) missQuote.push(`${r.id} 「${x.quote}」（${x.speaker}）`);
    }
  }
  md.push(`数字: ${missNum.length}件 / ${nNum}件`, "", ...missNum.slice(0, 40).map((s) => `- ${s}`), "");
  md.push(`引用: ${missQuote.length}件 / ${nQuote}件`, "", ...missQuote.slice(0, 40).map((s) => `- ${s}`));

  await writeFile(path.join(DIR, "report.md"), md.join("\n") + "\n");
  console.log(`まとまり ${exs.size}件 → 項目 ${recs.length}件、失敗 ${errs.length}件`);
  console.log(`その他 ${recs.filter((r) => r.topic === "その他").length}件、迷った項目 ${recs.filter((r) => r.topic_alternative !== "なし").length}件、1件もない話題 ${zero.length}個`);
  console.log(`原文に見つからない: 数字 ${missNum.length}/${nNum}、引用 ${missQuote.length}/${nQuote}`);
  console.log(`出力: data/topics/trial/${MODEL}/report.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
