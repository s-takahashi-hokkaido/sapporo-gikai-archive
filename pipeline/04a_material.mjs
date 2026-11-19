#!/usr/bin/env node
// 工程4 手順1: 話題の一覧の下書きの材料を取り出す。
// 作り方: docs/作り方.md の工程4
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/04a_material.mjs
//
// 入力: data/struct/exchanges/<年>-k1,k2,k3.jsonl（工程3 T4・T5）
// 出力: data/topics/material.md     人と AI が読む一覧（同じ言い回しをまとめ、件数・任期・会派を付ける）
//       data/topics/material.jsonl  同じものを1行1件で（04b の振り分けの入力）
//
// 材料は2つ。
// - 代表質問の大項目（本会議。目次から取ったもの）
// - 常任委員会と調査特別委員会の議題（質疑と説明のまとまりの議題）。予算・決算特別委員会の議題は「第２款　総務費」のような款項なので使わない
// 委員会の議題のうち、中身が分からないもの（関係理事者の紹介、補正予算だけの議案、陳情◯件 など）は外す。外した件数は最後に出す

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STRUCT = path.join(here, "..", "data", "struct");
const OUT = path.join(here, "..", "data", "topics");
const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

// 大項目の頭の番号や前後の空白を外す。中身は変えない
const normItem = (s) =>
  s
    .replace(/^[\s　]*(?:[（(]?[0-9０-９一二三四五六七八九十]+[）)．.、　\s]+)/, "")
    .replace(/[\s　]+/g, " ")
    .trim();

// 中身が分からない委員会の議題
const NOISE = [
  /関係理事者の紹介/,
  /^参考人/,
  /^陳情[０-９0-9]+件$/,
  /^議案第[０-９0-9]+号から/,
  /^[^　]*局に係る議案第/, // 局ごとに議案番号を並べただけで件名がない
  /^議案第[０-９0-9]+号(?:中、?関係分)?$/,
];
const isBudgetOnly = (a) => /^議案第[０-９0-9]+号　[^、]*補正予算[^、]*(?:中、?関係分)?(?:及び議案第[０-９0-9]+号　[^、]*(?:補正予算|会計)[^、]*)?(?:の[０-９0-9]+件)?$/.test(a);
const normAgenda = (s) => s.replace(/^本日は、/, "").replace(/[\s　]+/g, "　").trim();

const termLabel = (t) => (t ? t.slice(2, 4) : "?"); // "2023-2027" → "23"

async function main() {
  const files = (await readdir(path.join(STRUCT, "exchanges"))).filter((f) => /^\d{4}-k[123]\.jsonl$/.test(f)).sort();
  const groups = new Map(); // key → { source, text, committee, count, terms:Set, years:Set, factions:Map }
  const dropped = { noise: 0, budget: 0, noAgenda: 0 };
  const add = (source, text, committee, e) => {
    const key = `${source}\t${committee ?? ""}\t${text}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { source, text, committee, count: 0, terms: new Set(), years: new Set(), factions: new Map() }));
    g.count++;
    g.terms.add(termLabel(e.term));
    g.years.add(e.date.slice(0, 4));
    if (e.faction) g.factions.set(e.faction, (g.factions.get(e.faction) ?? 0) + 1);
  };

  let items = 0;
  let agendas = 0;
  for (const f of files) {
    for (const e of await readJsonl(path.join(STRUCT, "exchanges", f))) {
      if (e.type === "代表質問" && e.items?.length) {
        for (const it of e.items) {
          add("代表質問", normItem(it), null, e);
          items++;
        }
      } else if (e.kind === "委員会" && (e.committee_type === "常任" || e.committee_type === "調査特別") && (e.type === "質疑" || e.type === "説明")) {
        if (!e.agenda) {
          dropped.noAgenda++;
          continue;
        }
        const a = normAgenda(e.agenda);
        if (NOISE.some((re) => re.test(a))) {
          dropped.noise++;
          continue;
        }
        if (isBudgetOnly(a)) {
          dropped.budget++;
          continue;
        }
        add("委員会", a, e.committee, e);
        agendas++;
      }
    }
  }

  const rows = [...groups.values()].map((g) => ({
    source: g.source,
    committee: g.committee,
    text: g.text,
    count: g.count,
    terms: [...g.terms].sort(),
    years: [...g.years].sort(),
    factions: [...g.factions].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}${n > 1 ? `×${n}` : ""}`),
  }));
  rows.sort((a, b) => (a.source === b.source ? 0 : a.source === "代表質問" ? -1 : 1) || (a.committee ?? "").localeCompare(b.committee ?? "", "ja") || b.count - a.count || a.text.localeCompare(b.text, "ja"));

  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "material.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const yspan = (ys) => (ys.length === 1 ? ys[0] : `${ys[0]}–${ys.at(-1)}`);
  const md = [];
  const rep = rows.filter((r) => r.source === "代表質問");
  const com = rows.filter((r) => r.source === "委員会");
  md.push("# 話題の一覧の下書きの材料", "");
  md.push(`\`node pipeline/04a_material.mjs\` で作る。代表質問の大項目 ${items}件（言い回しをまとめて ${rep.length}種類）、常任委員会と調査特別委員会の議題 ${agendas}件（${com.length}種類）。`, "");
  md.push("列は「件数 | 任期の頭の年 | 年 | 言い回し | 会派」。任期の頭の年は 07＝2007–2011 のように読む。", "");
  md.push("## 代表質問の大項目", "");
  for (const r of rep.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "ja")))
    md.push(`${r.count} | ${r.terms.join(",")} | ${yspan(r.years)} | ${r.text} | ${r.factions.slice(0, 3).join("、")}`);
  md.push("", "## 委員会の議題（委員会ごと）", "");
  let cur = null;
  for (const r of com) {
    if (r.committee !== cur) {
      cur = r.committee;
      md.push("", `### ${cur}`, "");
    }
    md.push(`${r.count} | ${r.terms.join(",")} | ${yspan(r.years)} | ${r.text.length > 160 ? r.text.slice(0, 160) + "…" : r.text}`);
  }
  await writeFile(path.join(OUT, "material.md"), md.join("\n") + "\n");

  console.log(`代表質問の大項目: ${items}件 → ${rep.length}種類`);
  console.log(`委員会の議題: ${agendas}件 → ${com.length}種類（委員会 ${new Set(com.map((r) => r.committee)).size}）`);
  console.log(`外した委員会の議題: 中身が分からない ${dropped.noise}件、補正予算だけ ${dropped.budget}件、議題なし ${dropped.noAgenda}件`);
  console.log(`出力: data/topics/material.md、material.jsonl`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
