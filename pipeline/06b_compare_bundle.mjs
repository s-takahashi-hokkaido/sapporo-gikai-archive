#!/usr/bin/env node
// 工程6の試行: 同じ組をモデルごとにまとめた結果を比べる（工程6に使うモデルを決める材料）。API は呼ばない。
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/06b_compare_bundle.mjs                  # data/bundle/trial/ の下のフォルダ（モデルごと）をすべて比べる
//   node pipeline/06b_compare_bundle.mjs claude-opus-5-5 claude-haiku-5-5-v2   # フォルダを選ぶ（この順に並べる）
// 出力: data/bundle/trial/compare.md（数で比べる表と、問題の例）
//       data/bundle/trial/side/<組>.md（同じ組のまとめを、モデルごとに並べたもの。人が読み比べる用）
//
// 数えるもの（どれも機械的な目安。「見つからない」がすべて誤りとは限らないので、例を読んで確かめる）:
// - 出典のない文: 句点で区切った文のうち、記録の番号 [246405-1] が1つもないもの
// - 入力にない番号: その組の記録にない番号（でっちあげの出典）
// - 数字: 文中の数字が、その文で引いた記録（見出し・要旨・数字・約束・日付）に見つからないもの。月・日は数えない
// - 引用: 「」の中身を、その文で引いた記録の約束の原文と比べる。
//   一致 / 引いた記録が違う（同じ組のほかの記録の約束にはある）/ 要旨にある語句（事業名などを要旨から「」で写したもの）/ どこにもない
// - 引いた記録の割合: 入力の記録のうち、どれかの文で出典に使ったもの

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, toHalfDigits } from "./lib.mjs";
import { buildCells, loadRecords, marksOf, renderMd, sentences, termLabel } from "./06_bundle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const TRIAL = path.join(ROOT, "data", "bundle", "trial");
const ORDER = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

const norm = (s) => toHalfDigits(s ?? "").replace(/[，,]/g, "").replace(/．/g, ".").replace(/[\s　]/g, "");
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hay = (r) => norm([r.title, r.question, r.answer, r.date, r.committee, ...r.places, ...r.numbers.flatMap((n) => [n.value, n.meaning]), ...r.commitments.map((c) => c.quote)].join("｜"));

function analyze(c, o, recById) {
  const ids = new Set(c.recs.map((r) => r.id));
  const cellCommit = c.recs.flatMap((r) => r.commitments.map((x) => norm(x.quote)));
  const m = { sentences: 0, noCite: 0, unknown: 0, nums: 0, numMiss: 0, quotes: 0, qOk: 0, qOther: 0, qSummary: 0, qNone: 0, cited: new Set(), examples: [] };
  const fields = [["要点", o.summary], ...o.developments.map((d) => [`動き「${d.heading}」`, d.text]), ...o.factions.map((f) => [`会派「${f.faction}」`, f.text]), ...o.city_stance.map((s) => ["答弁の変化", s]), ...o.open_issues.map((s) => ["残る論点", s])];
  for (const [where, text] of fields)
    for (const s of sentences(text)) {
      m.sentences++;
      const marks = marksOf(s);
      const body = s.replace(/\[[^\]]*\]/g, "");
      if (!marks.length) {
        m.noCite++;
        m.examples.push(`出典のない文（${where}）: ${body.slice(0, 80)}`);
        continue;
      }
      const recs = [];
      for (const id of marks) {
        if (!ids.has(id)) {
          m.unknown++;
          m.examples.push(`入力にない番号 ${id}（${where}）`);
        } else {
          m.cited.add(id);
          recs.push(recById.get(id));
        }
      }
      const h = recs.map(hay).join("｜");
      // 数字
      const nb = norm(body);
      for (const x of nb.matchAll(/\d+(?:\.\d+)?/g)) {
        const after = nb.slice(x.index + x[0].length, x.index + x[0].length + 2);
        const before = nb.slice(Math.max(0, x.index - 2), x.index);
        if (/^[月日時]/.test(after) || /^(年|年度)/.test(after) && x[0].length <= 2 && !/(平成|令和|昭和)$/.test(before)) continue; // 月・日、「3年」のような期間は数えない
        m.nums++;
        const isYear = /^(19[89]\d|20[0-3]\d)$/.test(x[0]) && /^(年|〜|~|-|－)/.test(after); // 「2019年」「2019〜2020年」
        // 年は、引いた記録の日付の前後1年（年度や「冬」が年をまたぐため）か、記録の本文にあればよい
        const found = isYear ? recs.some((r) => Math.abs(Number(r.date.slice(0, 4)) - Number(x[0])) <= 1) || h.includes(x[0]) : new RegExp(`(?<![\\d.])${esc(x[0])}(?![\\d])`).test(h);
        if (!found) {
          m.numMiss++;
          m.examples.push(`数字が引いた記録にない「${x[0]}」（${where}）: ${body.slice(0, 80)}`);
        }
      }
      // 引用
      for (const q of body.matchAll(/「([^」]+)」/g)) {
        m.quotes++;
        const qq = norm(q[1]);
        if (recs.some((r) => r.commitments.some((x) => norm(x.quote).includes(qq)))) m.qOk++;
        else if (cellCommit.some((x) => x.includes(qq))) {
          m.qOther++;
          m.examples.push(`引用の出典が違う（${where}）: 「${q[1].slice(0, 50)}」`);
        } else if (h.includes(qq)) m.qSummary++;
        else {
          m.qNone++;
          m.examples.push(`引用がどこにもない（${where}）: 「${q[1].slice(0, 60)}」`);
        }
      }
    }
  m.citedRatio = m.cited.size / ids.size;
  return m;
}

async function main() {
  const topics = parseCsv(await readFile(path.join(here, "topics.csv"), "utf8"));
  const records = await loadRecords();
  const recById = new Map(records.map((r) => [r.id, r]));
  const cells = buildCells(records, topics);

  let labels = process.argv.slice(2);
  if (!labels.length) {
    labels = (await readdir(TRIAL, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== "side").map((d) => d.name);
    labels.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  }
  // 組ごとに、どのモデルの結果があるか
  const res = new Map(); // key -> label -> {file, m}
  for (const label of labels) {
    const dir = path.join(TRIAL, label);
    if (!existsSync(dir)) throw new Error(`フォルダがない: ${dir}`);
    for (const f of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
      const j = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      const key = `${j.topic}__${j.term}`;
      const c = cells.get(key);
      if (!c) continue;
      if (!res.has(key)) res.set(key, new Map());
      res.get(key).set(label, { j, m: analyze(c, j.output, recById) });
    }
  }
  const keys = [...res.keys()].sort((a, b) => cells.get(a).recs.length - cells.get(b).recs.length);

  // モデルごとの合計
  const tot = Object.fromEntries(labels.map((l) => [l, { cells: 0, chars: 0, cost: 0, sentences: 0, noCite: 0, unknown: 0, nums: 0, numMiss: 0, quotes: 0, qOk: 0, qOther: 0, qSummary: 0, qNone: 0, cited: 0, recs: 0, outTok: 0 }]));
  for (const k of keys)
    for (const [l, { j, m }] of res.get(k)) {
      const t = tot[l];
      t.cells++;
      t.chars += JSON.stringify(j.output).length;
      t.cost += j.usage.cost;
      t.outTok += j.usage.output;
      for (const f of ["sentences", "noCite", "unknown", "nums", "numMiss", "quotes", "qOk", "qOther", "qSummary", "qNone"]) t[f] += m[f];
      t.cited += m.cited.size;
      t.recs += cells.get(k).recs.length;
    }
  const row = (name, f) => `| ${name} | ${labels.map((l) => f(tot[l])).join(" | ")} |`;
  const lines = [
    "# 工程6の試行の比べ合わせ",
    "",
    `${new Date().toLocaleString("ja-JP")} に \`06b_compare_bundle.mjs\` で作った。組 ${keys.length}。数は機械的な目安で、「見つからない」がすべて誤りとは限らない（下の「問題の例」で確かめる）。読み比べは \`side/<組>.md\`。`,
    "",
    "## モデルごとの合計",
    "",
    `| | ${labels.join(" | ")} |`,
    `|---|${labels.map(() => "---").join("|")}|`,
    row("まとめた組", (t) => t.cells),
    row("料金の目安（バッチ）", (t) => `$${t.cost.toFixed(2)}`),
    row("出力トークン（考える過程を含む）", (t) => t.outTok.toLocaleString()),
    row("まとめの字数", (t) => t.chars.toLocaleString()),
    row("文の数", (t) => t.sentences),
    row("出典のない文", (t) => `${t.noCite}（${pct(t.noCite, t.sentences)}）`),
    row("入力にない番号", (t) => t.unknown),
    row("数字: 引いた記録に見つからない", (t) => `${t.numMiss}/${t.nums}（${pct(t.numMiss, t.nums)}）`),
    row("引用: 約束の原文と一致", (t) => `${t.qOk}/${t.quotes}（${pct(t.qOk, t.quotes)}）`),
    row("引用: 引いた記録が違う", (t) => t.qOther),
    row("引用: 要旨にある語句", (t) => t.qSummary),
    row("引用: どこにもない", (t) => t.qNone),
    row("引いた記録の割合", (t) => pct(t.cited, t.recs)),
    "",
    "## 組ごと",
  ];
  for (const k of keys) {
    const c = cells.get(k);
    const r = res.get(k);
    const cell = (l, f) => (r.has(l) ? f(r.get(l)) : "—");
    const crow = (name, f) => `| ${name} | ${labels.map((l) => cell(l, f)).join(" | ")} |`;
    lines.push(
      "",
      `### ${c.topic}　${termLabel(c.term)}（記録 ${c.recs.length}件、${(c.chars / 1e4).toFixed(1)}万字${c.parts.length > 1 ? `、時期で${c.parts.length}つに分けた` : ""}）`,
      "",
      `| | ${labels.join(" | ")} |`,
      `|---|${labels.map(() => "---").join("|")}|`,
      crow("料金の目安", ({ j }) => `$${j.usage.cost.toFixed(3)}`),
      crow("字数", ({ j }) => JSON.stringify(j.output).length.toLocaleString()),
      crow("主な動き／会派／答弁の変化／残る論点", ({ j }) => [j.output.developments.length, j.output.factions.length, j.output.city_stance.length, j.output.open_issues.length].join("／")),
      crow("出典のない文", ({ m }) => `${m.noCite}/${m.sentences}`),
      crow("入力にない番号", ({ m }) => m.unknown),
      crow("数字の見つからない", ({ m }) => `${m.numMiss}/${m.nums}`),
      crow("引用の一致／違う記録／要旨／どこにもない", ({ m }) => `${m.qOk}／${m.qOther}／${m.qSummary}／${m.qNone}`),
      crow("引いた記録の割合", ({ m }) => pct(m.cited.size, c.recs.length)),
    );
  }
  lines.push("", "## 問題の例（モデルごとに最大20件）");
  for (const l of labels) {
    const ex = keys.flatMap((k) => (res.get(k).get(l)?.m.examples ?? []).map((e) => `- ${cells.get(k).topic} ${cells.get(k).term}: ${e}`));
    lines.push("", `### ${l}（${ex.length}件）`, "", ...(ex.length ? ex.slice(0, 20) : ["なし"]));
  }
  await writeFile(path.join(TRIAL, "compare.md"), lines.join("\n") + "\n");

  // 読み比べ用: 同じ組をモデルごとに並べる
  await mkdir(path.join(TRIAL, "side"), { recursive: true });
  for (const k of keys) {
    const c = cells.get(k);
    const parts = labels.filter((l) => res.get(k).has(l)).map((l) => {
      const { j } = res.get(k).get(l);
      return `<!-- ==================== ${l} ==================== -->\n\n${renderMd(c, j.output, j, recById).replace(/^# .*\n/, `# ${l}\n`)}`;
    });
    await writeFile(path.join(TRIAL, "side", `${k}.md`), `# ${c.topic}　${termLabel(c.term)} の読み比べ\n\n${parts.join("\n\n---\n\n")}\n`);
  }
  console.log(`比べた: 組 ${keys.length}、モデル ${labels.join("、")} → ${path.relative(ROOT, path.join(TRIAL, "compare.md"))}、side/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
