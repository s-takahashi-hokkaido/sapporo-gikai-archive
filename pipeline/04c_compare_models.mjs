#!/usr/bin/env node
// 工程4・5: 同じ試行の300件を別のモデルで分類した結果を比べ、工程5の本番に使うモデルを決める材料を出す。
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/04c_compare_models.mjs claude-haiku-5-5            # claude-opus-5-5 を基準に比べる
//   node pipeline/04c_compare_models.mjs claude-haiku-5-5 claude-sonnet-5-5   # 2つめを基準にする
//
// 入力: data/topics/trial/<モデル>/records.jsonl、empty.jsonl、errors.jsonl（05_classify.mjs --trial --model <モデル>）、
//       data/struct/speeches/<年>.jsonl
// 出力: data/topics/trial/compare-<基準>-vs-<比べるモデル>.md
// 見るもの:
// - 話題の一致: まとまりごとに、基準のモデルが付けた主の話題の集まりのうち、比べるモデルも付けた割合（項目の分け方が違っても比べられる）
// - 原文に見つからない数字・引用の割合（多いモデルは、演説の下調べには使えない）
// - 項目の数、項目なし、その他、失敗の数
// - 話題がいちばん食い違ったまとまり（人が読んで、どちらが正しいかを見る）

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const TRIAL = path.join(ROOT, "data", "topics", "trial");
const readJsonl = async (p) => (existsSync(p) ? (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const norm = (s) => s.replace(/[０-９Ａ-Ｚａ-ｚ．，％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[\s　]/g, "");
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
const kindOf = (r) => (r.type === "代表質問" ? "代表質問" : r.kind === "委員会" && r.type === "質疑" ? "委員会の質疑" : "その他の種類");

async function load(model, sp) {
  const dir = path.join(TRIAL, model);
  const recs = await readJsonl(path.join(dir, "records.jsonl"));
  const empty = await readJsonl(path.join(dir, "empty.jsonl"));
  const errs = await readJsonl(path.join(dir, "errors.jsonl"));
  if (!recs.length) throw new Error(`記録がない: ${dir}`);
  for (const y of new Set(recs.map((r) => r.date.slice(0, 4))))
    if (![...sp.keys()].some((k) => k.startsWith(`${y}:`)))
      for (const s of await readJsonl(path.join(ROOT, "data", "struct", "speeches", `${y}.jsonl`))) sp.set(`${y}:${s.huid}`, norm(s.text));
  const byEx = new Map();
  for (const r of recs) {
    if (!byEx.has(r.exchange)) byEx.set(r.exchange, []);
    byEx.get(r.exchange).push(r);
  }
  let nNum = 0, missNum = 0, nQ = 0, missQ = 0;
  const missList = [];
  for (const r of recs) {
    const y = r.date.slice(0, 4);
    const text = r.huids.map((h) => sp.get(`${y}:${h}`) ?? "").join("");
    for (const x of r.numbers) (nNum++, text.includes(norm(x.value)) || (sp.get(`${y}:${x.huid}`) ?? "").includes(norm(x.value)) || (missNum++, missList.push(`${r.id} 数字 ${x.value}（${x.meaning}）`)));
    for (const x of r.commitments) (nQ++, text.includes(norm(x.quote)) || (sp.get(`${y}:${x.huid}`) ?? "").includes(norm(x.quote)) || (missQ++, missList.push(`${r.id} 引用 「${x.quote}」`)));
  }
  return { model, recs, empty, errs, byEx, emptyIds: new Set(empty.map((e) => e.exchange)), nNum, missNum, nQ, missQ, missList };
}

async function main() {
  const [other, base = "claude-opus-5-5"] = process.argv.slice(2);
  if (!other) throw new Error("比べるモデルを指定する（例: node pipeline/04c_compare_models.mjs claude-haiku-5-5）");
  const sp = new Map();
  const A = await load(base, sp);
  const B = await load(other, sp);

  const md = [`# 試行の比べ合わせ: ${base}（基準） と ${other}`, "", "`node pipeline/04c_compare_models.mjs` で作る。", ""];
  md.push("## 全体", "", `| | ${base} | ${other} |`, "|---|---|---|");
  for (const [label, f] of [
    ["記録できたまとまり", (M) => M.byEx.size + M.emptyIds.size],
    ["項目", (M) => M.recs.length],
    ["項目なし（手続きだけ）", (M) => M.emptyIds.size],
    ["失敗", (M) => M.errs.length],
    ["「その他」の項目", (M) => `${M.recs.filter((r) => r.topic === "その他").length}（${pct(M.recs.filter((r) => r.topic === "その他").length, M.recs.length)}）`],
    ["区を付けた項目", (M) => pct(M.recs.filter((r) => !r.areas.includes("全市")).length, M.recs.length)],
    ["原文に見つからない数字", (M) => `${M.missNum}/${M.nNum}（${pct(M.missNum, M.nNum)}）`],
    ["原文に見つからない引用", (M) => `${M.missQ}/${M.nQ}（${pct(M.missQ, M.nQ)}）`],
  ])
    md.push(`| ${label} | ${f(A)} | ${f(B)} |`);

  // 話題の一致（両方で項目のあるまとまりだけ）
  const both = [...A.byEx.keys()].filter((id) => B.byEx.has(id));
  const stat = {};
  const rows = [];
  for (const id of both) {
    const a = new Set(A.byEx.get(id).map((r) => r.topic));
    const b = new Set(B.byEx.get(id).map((r) => r.topic));
    const hit = [...a].filter((t) => b.has(t)).length;
    const hitB = [...b].filter((t) => a.has(t)).length;
    const k = kindOf(A.byEx.get(id)[0]);
    stat[k] ??= { n: 0, a: 0, hit: 0, b: 0, hitB: 0, itemsA: 0, itemsB: 0 };
    Object.assign(stat[k], { n: stat[k].n + 1, a: stat[k].a + a.size, hit: stat[k].hit + hit, b: stat[k].b + b.size, hitB: stat[k].hitB + hitB, itemsA: stat[k].itemsA + A.byEx.get(id).length, itemsB: stat[k].itemsB + B.byEx.get(id).length });
    rows.push({ id, score: a.size ? hit / a.size : 1, a: A.byEx.get(id), b: B.byEx.get(id) });
  }
  md.push("", "## 話題の一致", "", `両方で項目のあるまとまり ${both.length}件。「拾えた割合」は、基準のモデルが付けた主の話題のうち、${other} も同じまとまりに付けた割合。「当たった割合」は逆に、${other} が付けた主の話題のうち、基準のモデルも付けた割合（項目を細かく分けるモデルは、拾えた割合だけが高く出るので、両方を見る）。`, "");
  md.push("| 種類 | まとまり | 拾えた割合 | 当たった割合 | 項目の数（基準 → 比べるモデル） |", "|---|---|---|---|---|");
  let tn = 0, ta = 0, th = 0, tb = 0, thb = 0;
  for (const [k, s] of Object.entries(stat)) {
    md.push(`| ${k} | ${s.n} | ${pct(s.hit, s.a)} | ${pct(s.hitB, s.b)} | ${s.itemsA} → ${s.itemsB} |`);
    (tn += s.n), (ta += s.a), (th += s.hit), (tb += s.b), (thb += s.hitB);
  }
  md.push(`| 計 | ${tn} | ${pct(th, ta)} | ${pct(thb, tb)} | |`);
  const onlyA = [...A.emptyIds].filter((id) => B.byEx.has(id)).length;
  const onlyB = [...B.emptyIds].filter((id) => A.byEx.has(id)).length;
  md.push("", `項目なしの判断が食い違ったまとまり: 基準だけが項目なし ${onlyA}件、${other} だけが項目なし ${onlyB}件`);

  md.push("", "## 話題がいちばん食い違ったまとまり（上位20）", "", "人が読んで、どちらの付け方が正しいかを見る。", "");
  for (const r of rows.sort((x, y) => x.score - y.score).slice(0, 20)) {
    const h = r.a[0];
    md.push(`### ${h.date} ${h.committee ?? h.kind} ${h.type}（まとまり ${r.id}、一致 ${pct(r.score * 1000, 1000)}）`, "");
    md.push(`- ${base}: ${r.a.map((x) => `${x.title}〔${x.topic}〕`).join("／")}`);
    md.push(`- ${other}: ${r.b.map((x) => `${x.title}〔${x.topic}〕`).join("／")}`, "");
  }

  md.push("", `## ${other} で原文に見つからない数字・引用`, "", ...B.missList.map((x) => `- ${x}`));

  const out = path.join(TRIAL, `compare-${base}-vs-${other}.md`);
  await writeFile(out, md.join("\n") + "\n");
  console.log(`話題 拾えた ${pct(th, ta)}・当たった ${pct(thb, tb)}（${tn}件）。原文に見つからない数字 ${base} ${pct(A.missNum, A.nNum)} / ${other} ${pct(B.missNum, B.nNum)}、引用 ${pct(A.missQ, A.nQ)} / ${pct(B.missQ, B.nQ)}`);
  console.log(`出力: ${path.relative(ROOT, out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
