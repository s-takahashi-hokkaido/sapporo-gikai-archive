#!/usr/bin/env node
// 工程6: 話題×任期（4年）ごとに、工程5の記録（要旨）だけを読み、その4年の経緯をまとめる。原文は読まない。
// 作り方: docs/作り方.md の工程6
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/06_bundle.mjs --list                         # 話題×任期ごとの記録の数と量を出す（API を呼ばない）
//   node --env-file=.env pipeline/06_bundle.mjs --pillars      # 本番: 細かく分けた5分野の話題（既定のモデルは Opus）
//   node --env-file=.env pipeline/06_bundle.mjs --others       # 本番: ほかの分野の話題（既定のモデルは Sonnet）
//   node --env-file=.env pipeline/06_bundle.mjs --topic 地下鉄 # 本番: 1つの話題だけ（既定のモデルは、細かく分けた5分野なら Opus、ほかは Sonnet）
//   node pipeline/06_bundle.mjs --pillars --dry-run            # 送る組と量を確かめる（1件目の中身が data/bundle/dry-run-request.json に出る）
//   node --env-file=.env pipeline/06_bundle.mjs --trial --model claude-opus-5-5 # 試行: 決まった7組をまとめる。結果は data/bundle/trial/<モデル>/（比べ合わせは 06b_compare_bundle.mjs）
//   node --env-file=.env pipeline/06_bundle.mjs --trial --probe [--model ...]   # 試行の中でいちばん小さい組を、バッチを使わずに1つだけ送って結果を見る（何も書かない）
//   node --env-file=.env pipeline/06_bundle.mjs --collect <batch_id>            # 途中で止めたときに、そのバッチの結果を取って続ける（送ったときの設定は batches.jsonl から読む）
//   node pipeline/06_bundle.mjs --render                       # API を呼ばずに bundles/ の .md を作り直す。工程8（08_verify.mjs）のあとに流すと、要確認の文に印が付く
// オプション: --model、--fallback-model claude-opus-5-5（2回落ちたものを流し直すモデル）、--effort medium、--max-tokens 64000、
//             --tag v2（試行の出力のフォルダ名に付ける名札。指示書を変えて同じモデルで試し直すとき）
//
// 入力: records/<年>.jsonl（工程5）、pipeline/topics.csv、pipeline/prompts/06_bundle_v2.md（v1 は試行と本番の前半）
// 出力（本番）: bundles/<話題>/<任期>.json と .md（読む用。出典の番号を会議録へのリンクにしたもの）、
//       大きい組の時期ごとのまとめは bundles/<話題>/parts/、失敗の控えは bundles/errors.jsonl、送ったバッチの控えは data/bundle/batches.jsonl
// - 読むのは主の話題の記録だけ（副の話題は年表にだけ載せる。docs/作り方.md の工程4）
// - 2003-2007 の任期は外す（2007年1〜4月の記録だけで、要件の「2007年4月からの20年」の外。年表には載せる）
// - 1回に読む量を PART_CHARS 字までにする。超える組は日付で時期に分けて時期ごとにまとめ（1回目のバッチ）、
//   それを1つにまとめ直す（2回目のバッチ）
// - 出典は記録の id（[246405-1]）で書かせ、URL はコードで付ける。AI に URL を書かせない
// - 形式チェック（check）に落ちたものは、次の回で送り直す。2回落ちたものは --fallback-model で流し直す。
//   試行で Sonnet が1組で崩れた（中身のない文を並べ、欄が空のまま終わった）ので、出典のない文・同じ文の繰り返し・空の欄も見る
// - まとめ済みの組は飛ばすので、何度流してもよい

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCsv } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const PROMPT_VERSION = "06_bundle_v2"; // v2: 書き出しの文にも番号を付ける（本番で Sonnet の25%が、書き出しの文に番号がなくて形式チェックに落ちたため。2026年11月18日）
const PART_CHARS = 75_000; // 1回に読む記録の量の上限（字）。Haiku は1回の入力が10万トークンを超えると料金が上がるので、それより下に収める
const SKIP_TERMS = ["2003-2007"];
const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5";
// バッチの料金（100万トークンあたりのドル。通常の半額）。見積もりの表示にだけ使う
const BATCH_PRICE = {
  "claude-opus-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite1h: 4 },
  "claude-sonnet-5-5": { in: 1, out: 5, cacheRead: 0.05, cacheWrite1h: 2 },
  "claude-haiku-5-5": { in: 0.05, out: 0.25, cacheRead: 0.005, cacheWrite1h: 0.1, over100k: { in: 0.25, out: 1.25, cacheRead: 0.025, cacheWrite1h: 0.5 } },
};

// 試行の組。細かく分けた5分野から1つずつ（任期もばらす）、ほかの分野から2つ。記録の少ない組と、時期に分ける大きい組を入れる
const TRIAL_CELLS = [
  ["除排雪の体制と費用", "2019-2023"],
  ["保育と幼児教育", "2023-2027"],
  ["地下鉄", "2015-2019"],
  ["町内会・自治会", "2007-2011"],
  ["市役所のDX・AI・データ活用", "2011-2015"],
  ["医療と健康づくり", "2015-2019"],
  ["感染症対策", "2019-2023"],
];

const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const a = { list: false, render: false, trial: false, pillars: false, others: false, topic: null, dryRun: false, probe: false, collect: null, model: null, fallback: OPUS, effort: "medium", maxTokens: 64000, tag: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--list") a.list = true;
    else if (k === "--render") a.render = true;
    else if (k === "--trial") a.trial = true;
    else if (k === "--pillars") a.pillars = true;
    else if (k === "--others") a.others = true;
    else if (k === "--topic") a.topic = argv[++i];
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--probe") a.probe = true;
    else if (k === "--collect") a.collect = argv[++i];
    else if (k === "--model") a.model = argv[++i];
    else if (k === "--fallback-model") a.fallback = argv[++i];
    else if (k === "--effort") a.effort = argv[++i];
    else if (k === "--max-tokens") a.maxTokens = Number(argv[++i]);
    else if (k === "--tag") a.tag = argv[++i];
    else throw new Error(`知らないオプション: ${k}`);
  }
  const modes = [a.list, a.render, a.trial, a.pillars, a.others, Boolean(a.topic), Boolean(a.collect)].filter(Boolean).length;
  if (modes !== 1) throw new Error("--list、--render、--trial、--pillars、--others、--topic <話題>、--collect <batch_id> のどれか1つを付ける");
  return a;
}

// 任期の見出し: "2019-2023" → "2019年5月〜2023年4月"
export const termLabel = (t) => {
  const [a, b] = t.split("-");
  return `${a}年5月〜${b}年4月`;
};
const cellKey = (topic, term) => `${topic}__${term}`;

// 記録1件を、AI に読ませる文にする
function recText(r) {
  const where = r.kind === "委員会" ? r.committee : `本会議（${r.kind}）`;
  const who = r.questioner ? `${r.questioner}（${r.faction ?? "会派不明"}）` : "質問者なし";
  const lines = [
    `[${r.id}] ${r.date}｜${where}｜${r.type}｜${who}`,
    `見出し: ${r.title}｜地域: ${r.areas.join("・")}${r.places.length ? `｜地名: ${r.places.join("、")}` : ""}`,
    `問: ${r.question}`,
    `答: ${r.answer}`,
  ];
  if (r.numbers.length) lines.push(`数字: ${r.numbers.map((n) => `${n.value}（${n.meaning}）`).join("／")}`);
  if (r.commitments.length) lines.push(`約束: ${r.commitments.map((c) => `${c.speaker}「${c.quote}」`).join("／")}`);
  return lines.join("\n");
}

export async function loadRecords() {
  const dir = path.join(ROOT, "records");
  const out = [];
  for (const f of (await readdir(dir)).filter((f) => /^\d{4}\.jsonl$/.test(f)).sort()) out.push(...(await readJsonl(path.join(dir, f))));
  return out;
}

// 主の話題×任期で組にする。記録は日付と id の順
export function buildCells(records, topics) {
  const row = new Map(topics.map((t) => [t["話題"], t]));
  const cells = new Map();
  for (const r of records) {
    const k = cellKey(r.topic, r.term);
    if (!cells.has(k)) cells.set(k, { key: k, topic: r.topic, term: r.term, pillar: row.get(r.topic)?.["柱"] || null, range: row.get(r.topic)?.["範囲"] ?? "", recs: [] });
    cells.get(k).recs.push(r);
  }
  const num = (id) => id.split("-").map(Number);
  for (const c of cells.values()) {
    c.recs.sort((a, b) => a.date.localeCompare(b.date) || num(a.id)[0] - num(b.id)[0] || num(a.id)[1] - num(b.id)[1]);
    c.texts = c.recs.map(recText);
    c.chars = c.texts.reduce((s, t) => s + t.length + 2, 0);
    c.parts = split(c);
  }
  return cells;
}

// 1回に読む量を超える組を、日付の切れ目で時期に分ける（同じ日の記録は分けない）
function split(c) {
  const idx = c.recs.map((_, i) => i);
  if (c.chars <= PART_CHARS) return [idx];
  const k = Math.ceil(c.chars / (PART_CHARS * 0.85));
  const target = c.chars / k;
  const parts = [];
  let cur = [], acc = 0;
  for (let i = 0; i < c.recs.length; i++) {
    cur.push(i);
    acc += c.texts[i].length + 2;
    const next = c.recs[i + 1];
    if (next && acc >= target && next.date !== c.recs[i].date) parts.push(cur), (cur = []), (acc = 0);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function header(c) {
  const first = c.recs[0].date, last = c.recs.at(-1).date;
  return [
    // API に送る入力。作ったときと同じにするため「5本柱」のまま（読む人の目に入る出力では「細かく分けた5分野」と書く）
    `話題: ${c.topic}${c.pillar ? `（5本柱「${c.pillar}」の1つ）` : ""}`,
    `話題の範囲: ${c.range}`,
    `任期: ${termLabel(c.term)}`,
    `記録: ${c.recs.length}件（${first}〜${last}）`,
  ].join("\n");
}

function partText(c, p) {
  const ids = c.parts[p];
  const from = c.recs[ids[0]].date, to = c.recs[ids.at(-1)].date;
  return [
    header(c),
    `この入力は、この任期の記録を時期で${c.parts.length}つに分けたうちの${p + 1}つ目（${from}〜${to}、${ids.length}件）です。この時期の分だけをまとめてください。`,
    "---",
    ids.map((i) => c.texts[i]).join("\n\n"),
  ].join("\n\n");
}
function singleText(c) {
  return [header(c), "---", c.texts.join("\n\n")].join("\n\n");
}
function mergeText(c, partOuts) {
  const blocks = partOuts.map((o, p) => {
    const ids = c.parts[p];
    return `=== 時期${p + 1}（${c.recs[ids[0]].date}〜${c.recs[ids.at(-1)].date}、記録 ${ids.length}件） ===\n\n${renderBody(o, null)}`;
  });
  return [
    header(c),
    `この任期の記録は多いので、時期で${c.parts.length}つに分けて、先に時期ごとにまとめてあります。以下はその時期ごとのまとめです。指示書の「時期ごとのまとめを1つにするとき」に従って、任期全体のまとめを書いてください。`,
    "---",
    blocks.join("\n\n"),
  ].join("\n\n");
}

function schema() {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "developments", "factions", "city_stance", "open_issues"],
    properties: {
      summary: str,
      developments: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["when", "heading", "text"], properties: { when: str, heading: str, text: str } },
      },
      factions: { type: "array", items: { type: "object", additionalProperties: false, required: ["faction", "text"], properties: { faction: str, text: str } } },
      city_stance: { type: "array", items: str },
      open_issues: { type: "array", items: str },
    },
  };
}

// 出典の番号: [246405-1] や [246405-1, 247001-3]
const MARK = /\[(\d+-\d+(?:\s*[,、]\s*\d+-\d+)*)\]/g;
export const marksOf = (s) => [...s.matchAll(MARK)].flatMap((m) => m[1].split(/\s*[,、]\s*/));
export const textsOf = (o) => [o.summary, ...o.developments.flatMap((d) => [d.heading, d.text]), ...o.factions.map((f) => f.text), ...o.city_stance, ...o.open_issues];
// 文を並べる欄（見出しを除く）
export const bodyTextsOf = (o) => [o.summary, ...o.developments.map((d) => d.text), ...o.factions.map((f) => f.text), ...o.city_stance, ...o.open_issues];

// 句点で文に分ける（「」と（）の中の句点では分けない）。句点のあとに番号を置いたもの（「…答えた。[1-1]」）は前の文に付ける
export function sentences(s) {
  const segs = [];
  let cur = "", depth = 0;
  for (const ch of s) {
    cur += ch;
    if (ch === "「" || ch === "（") depth++;
    else if ((ch === "」" || ch === "）") && depth > 0) depth--;
    else if (ch === "。" && depth === 0) segs.push(cur), (cur = "");
  }
  if (cur) segs.push(cur);
  const out = [];
  for (let seg of segs) {
    const lead = seg.match(/^\s*((?:\[[^\]]+\])+)/);
    if (lead && out.length) {
      out[out.length - 1] += lead[1];
      seg = seg.slice(lead[0].length);
    }
    if (seg.trim()) out.push(seg);
  }
  return out;
}

// 形式チェック。落ちた理由の配列を返す（空なら合格）。n はその回に読ませた記録の数
export function check(out, ids, n) {
  const errs = [];
  if (typeof out?.summary !== "string" || !out.summary.trim()) return ["要点が空"];
  const unknown = [...new Set(textsOf(out).flatMap(marksOf))].filter((m) => !ids.has(m));
  if (unknown.length) errs.push(`入力にない番号: ${unknown.slice(0, 5).join(" ")}${unknown.length > 5 ? ` ほか${unknown.length - 5}個` : ""}`);
  const ss = bodyTextsOf(out).flatMap(sentences);
  const noCite = ss.filter((s) => !marksOf(s).length);
  if (noCite.length >= 3 && noCite.length / ss.length > 0.1) errs.push(`出典のない文が多い（${noCite.length}/${ss.length}。例: ${noCite[0].slice(0, 40)}）`);
  const seen = new Map();
  for (const s of ss) {
    const k = s.replace(/\[[^\]]*\]/g, "").trim();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const rep = [...seen].filter(([k, v]) => v >= 5 && k.length > 0); // 会派ごとに同じ文（「〜は不採択とすべきだと主張した。」）が並ぶのは正しいので、5回から
  if (rep.length) errs.push(`同じ文の繰り返し（${rep[0][0].slice(0, 30)} ×${rep[0][1]}）`);
  if (n >= 10 && !out.developments.length) errs.push("主な動きが空");
  if (n >= 30 && !out.factions.length && !out.city_stance.length && !out.open_issues.length) errs.push("会派・答弁の変化・残る論点がすべて空");
  return errs;
}

// 工程8（08_verify.mjs）の要確認を読む。キーは「話題\t文書\t文（出典の番号を除く）」、値は印の文言
const FLAG_LABEL = {
  引用が会議録の原文と合わない: "要確認: 引用が原文と一致しない",
  数字が会議録の原文と合わない: "要確認: 数字が原文と一致しない",
  記録にない番号: "要確認: 出典の番号が誤り",
  引用が引いた記録にない: "要確認: 引用の出典が見つからない",
  数字が引いた記録にない: "要確認: 数字の出典が見つからない",
  出典のない文: "出典なし",
};
export async function loadFlags() {
  const p = path.join(ROOT, "verify", "summaries.jsonl"); // Git に入っているので、data/ のないクローンでも印が付く
  const m = new Map();
  if (!existsSync(p)) return m;
  for (const x of await readJsonl(p)) {
    const k = `${x.topic}\t${x.doc}\t${x.sentence.trim()}`;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(FLAG_LABEL[x.reason] ?? x.reason);
  }
  return m;
}
// 文ごとに、要確認の印を文の終わり（句点の前）に書き足す。flag(文) は印の文言か null を返す
export function markFlags(text, flag) {
  if (!flag) return text;
  return sentences(text)
    .map((s) => {
      const f = flag(s.replace(/\[[^\]]*\]/g, "").trim());
      return f ? (/。$/.test(s) ? s.replace(/。$/, `**［${f}］**。`) : `${s}**［${f}］**`) : s;
    })
    .join("");
}

// まとめを Markdown にする。link が渡されれば、出典の番号を会議録へのリンク（日付）にする。flag が渡されれば要確認の印を付ける
export function renderBody(o, link, flag) {
  const cite = (s0) => {
    const s = markFlags(s0, flag);
    return link ? s.replace(/(?:\[\d+-\d+(?:\s*[,、]\s*\d+-\d+)*\])+/g, (m) => `（${marksOf(m).map(link).join("、")}）`) : s;
  };
  const out = [`## この4年の要点\n\n${cite(o.summary)}`];
  if (o.developments.length) out.push(`## 主な動き\n\n${o.developments.map((d) => `### ${d.when}　${d.heading}\n\n${cite(d.text)}`).join("\n\n")}`);
  if (o.factions.length) out.push(`## 会派ごとの主張\n\n${o.factions.map((f) => `- **${f.faction}**: ${cite(f.text)}`).join("\n")}`);
  if (o.city_stance.length) out.push(`## 市の答弁の変化\n\n${o.city_stance.map((s) => `- ${cite(s)}`).join("\n")}`);
  if (o.open_issues.length) out.push(`## 残っている論点\n\n${o.open_issues.map((s) => `- ${cite(s)}`).join("\n")}`);
  return out.join("\n\n");
}
export function renderMd(c, o, meta, recById, flags) {
  const link = (id) => {
    const r = recById.get(id);
    return r ? `[${r.date}](${r.url})` : `[${id}?]`;
  };
  const flag = flags ? (s) => [...(flags.get(`${c.topic}\t任期 ${c.term}\t${s}`) ?? [])].join("、") || null : null;
  return [
    `# ${c.topic}　${termLabel(c.term)}`,
    `記録 ${c.recs.length}件${c.parts.length > 1 ? `（時期で${c.parts.length}つに分けてまとめ、1つにまとめ直した）` : ""}。モデル ${meta.model}、指示書 ${meta.prompt}。出典の日付は会議録へのリンク。` +
      (flags ? "「［要確認］」の付いた文は、工程8の照合で数字や引用を原文や記録で確かめられなかったもの（理由は topics/要確認.md）。" : ""),
    renderBody(o, link, flag),
  ].join("\n\n");
}

// Haiku は1回の入力が10万トークンを超えると、その回の料金が上がる
function usageCost(model, u) {
  const p = BATCH_PRICE[model];
  const inTotal = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const q = p?.over100k && inTotal > 100_000 ? p.over100k : p;
  if (!q) return 0;
  return ((u.input_tokens ?? 0) * q.in + (u.output_tokens ?? 0) * q.out + (u.cache_read_input_tokens ?? 0) * q.cacheRead + (u.cache_creation_input_tokens ?? 0) * q.cacheWrite1h) / 1e6;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const topics = parseCsv(await readFile(path.join(here, "topics.csv"), "utf8"));
  const records = await loadRecords();
  const recById = new Map(records.map((r) => [r.id, r]));
  const cells = buildCells(records, topics);
  const order = new Map(topics.map((t, i) => [t["話題"], i]));
  const sorted = [...cells.values()].sort((a, b) => order.get(a.topic) - order.get(b.topic) || a.term.localeCompare(b.term));

  if (args.list) {
    for (const c of sorted) console.log(`${c.pillar ?? "　"}\t${c.topic}\t${c.term}\t${c.recs.length}件\t${(c.chars / 1e4).toFixed(1)}万字\t${c.parts.length > 1 ? `${c.parts.length}つに分ける` : ""}${SKIP_TERMS.includes(c.term) ? "（外す）" : ""}`);
    const all = sorted.reduce((s, c) => s + c.chars, 0);
    console.log(`組 ${sorted.length}、記録 ${records.length}件、${(all / 1e4).toFixed(0)}万字、時期に分ける組 ${sorted.filter((c) => c.parts.length > 1).length}（分けたあとの回数 ${sorted.reduce((s, c) => s + (c.parts.length > 1 ? c.parts.length + 1 : 1), 0)}）`);
    return;
  }

  // --render: API を呼ばずに、本番のまとめ（bundles/）の .md を作り直す。工程8の要確認の印を付ける
  if (args.render) {
    const flags = await loadFlags();
    let n = 0, marked = 0;
    for (const c of sorted) {
      const p = path.join(ROOT, "bundles", c.topic, `${c.term}.json`);
      if (!existsSync(p)) continue;
      const j = JSON.parse(await readFile(p, "utf8"));
      const md = renderMd(c, j.output, j, recById, flags);
      marked += (md.match(/［(要確認|出典なし)/g) ?? []).length;
      await writeFile(path.join(ROOT, "bundles", c.topic, `${c.term}.md`), md + "\n");
      n++;
    }
    console.log(`.md を作り直した: ${n}組、要確認・出典なしの印 ${marked}個`);
    return;
  }

  // --collect は、送ったときの設定を控えから読む
  const batchLog = path.join(ROOT, "data", "bundle", "batches.jsonl");
  await mkdir(path.dirname(batchLog), { recursive: true });
  let pending = null;
  if (args.collect) {
    const b = (existsSync(batchLog) ? await readJsonl(batchLog) : []).find((x) => x.batch_id === args.collect);
    if (!b) throw new Error(`控えにないバッチ: ${args.collect}`);
    Object.assign(args, { model: b.model, fallback: b.fallback ?? OPUS, effort: b.effort, tag: b.tag ?? null, trial: b.trial, ...(b.select ?? {}) });
    pending = b;
  }

  // 対象の組と、既定のモデル（工程6の試行で決めた: 細かく分けた5分野は Opus、ほかは Sonnet）
  let targets;
  if (args.trial)
    targets = TRIAL_CELLS.map(([t, p]) => {
      const c = cells.get(cellKey(t, p));
      if (!c) throw new Error(`記録のない組: ${t} ${p}`);
      return c;
    });
  else {
    if (args.topic && !order.has(args.topic)) throw new Error(`一覧にない話題: ${args.topic}`);
    targets = sorted.filter((c) => !SKIP_TERMS.includes(c.term) && (args.topic ? c.topic === args.topic : args.pillars ? c.pillar : !c.pillar));
  }
  args.model ??= args.trial || args.pillars || (args.topic && targets[0]?.pillar) ? OPUS : SONNET;
  const select = { pillars: args.pillars, others: args.others, topic: args.topic };

  const label = [args.model, args.effort === "medium" ? null : args.effort, args.tag].filter(Boolean).join("-");
  const outDir = args.trial ? path.join(ROOT, "data", "bundle", "trial", label) : path.join(ROOT, "bundles");
  const name = args.trial ? label : args.topic ?? (args.pillars ? "細かく分けた5分野" : "ほか");
  const errFile = path.join(outDir, "errors.jsonl");
  const cellFile = (c, ext = "json") => (args.trial ? path.join(outDir, `${c.key}.${ext}`) : path.join(outDir, c.topic, `${c.term}.${ext}`));
  const partFile = (c, p) => (args.trial ? path.join(outDir, "parts", `${c.key}__p${p + 1}.json`) : path.join(outDir, c.topic, "parts", `${c.term}__p${p + 1}.json`));
  const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
  const write = async (p, s) => (await mkdir(path.dirname(p), { recursive: true }), writeFile(p, s));
  const prompt = await readFile(path.join(here, "prompts", `${PROMPT_VERSION}.md`), "utf8");

  const params = (text, model) => ({
    model,
    max_tokens: args.maxTokens,
    system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: text }],
    output_config: { effort: args.effort, format: { type: "json_schema", schema: schema() } },
  });

  // 失敗の回数（2回落ちたものは --fallback-model で流し直す）
  const jobKey = (j) => `${j.cell}|${j.kind}|${j.part ?? ""}`;
  async function failCounts() {
    const m = new Map();
    for (const e of existsSync(errFile) ? await readJsonl(errFile) : []) if (!String(e.reason).startsWith("バッチ:")) m.set(jobKey(e), (m.get(jobKey(e)) ?? 0) + 1); // バッチの失敗（クレジット不足など）は中身の失敗ではないので数えない
    return m;
  }

  // 送るものを決める: 分けない組はそのまま、分ける組は時期ごと（1回目）、時期がそろったら1つにまとめ直す（2回目）
  async function plan() {
    const fails = args.trial ? new Map() : await failCounts();
    const reqs = [];
    const add = (custom_id, job, text) => {
      job.model = (fails.get(jobKey(job)) ?? 0) >= 2 ? args.fallback : args.model;
      reqs.push({ custom_id, job, params: params(text, job.model) });
    };
    for (const [ci, c] of targets.entries()) {
      if (existsSync(cellFile(c))) continue;
      if (c.parts.length === 1) {
        add(`c${ci}`, { cell: c.key, kind: "cell" }, singleText(c));
        continue;
      }
      const missing = c.parts.map((_, p) => p).filter((p) => !existsSync(partFile(c, p)));
      if (missing.length) for (const p of missing) add(`c${ci}-p${p + 1}`, { cell: c.key, kind: "part", part: p }, partText(c, p));
      else {
        const outs = await Promise.all(c.parts.map(async (_, p) => (await readJson(partFile(c, p))).output));
        add(`c${ci}-m`, { cell: c.key, kind: "merge" }, mergeText(c, outs));
      }
    }
    return reqs;
  }

  // 1件の結果を書く。失敗なら理由を返す
  async function save(job, msg, usage) {
    const c = cells.get(job.cell);
    const ids = new Set(c.recs.map((r) => r.id));
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    let out;
    try {
      out = JSON.parse(text);
    } catch {
      return { reason: "JSON として読めない", detail: text.slice(0, 200) };
    }
    const n = job.kind === "part" ? c.parts[job.part].length : c.recs.length;
    const bad = check(out, ids, n);
    // 試行は、問題があっても書いて比べ合わせで数える（本番は送り直す）
    if (bad.length && !args.trial) return { reason: "形式チェック", detail: bad };
    const meta = { model: msg.model, effort: args.effort, prompt: PROMPT_VERSION, created: new Date().toISOString() };
    if (job.kind === "part") {
      const p = job.part;
      await write(partFile(c, p), JSON.stringify({ topic: c.topic, term: c.term, part: p + 1, of: c.parts.length, ids: c.parts[p].map((i) => c.recs[i].id), ...meta, usage, problems: bad, output: out }, null, 2));
      return null;
    }
    // まとめ直しの料金には、時期ごとの分も足す。モデルは時期ごとの分も含めて並べる
    const partJson = job.kind === "merge" ? await Promise.all(c.parts.map((_, p) => readJson(partFile(c, p)))) : [];
    const total = [usage, ...partJson.map((j) => j.usage)].reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite, cost: a.cost + u.cost }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    const models = [...new Set([msg.model, ...partJson.map((j) => j.model)])];
    const meta2 = { ...meta, model: models.join("、") };
    await write(cellFile(c), JSON.stringify({ topic: c.topic, term: c.term, pillar: c.pillar, records: c.recs.length, chars: c.chars, parts: c.parts.length, ...meta2, usage: total, problems: bad, output: out }, null, 2));
    await write(cellFile(c, "md"), renderMd(c, out, meta2, recById) + "\n");
    return null;
  }

  // SDK は API を呼ぶときだけ読む（--render や 08・07 からの読み込みは npm install なしで動く）
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  for (let round = 0; round < 5; round++) {
    let batchId, jobs;
    if (pending) {
      batchId = pending.batch_id;
      jobs = pending.jobs;
      pending = null;
    } else {
      const reqs = await plan();
      if (!reqs.length) break;
      const chars = reqs.reduce((s, r) => s + r.params.messages[0].content.length, 0);
      const kinds = reqs.reduce((m, r) => ((m[`${r.job.kind}(${r.job.model.replace("claude-", "")})`] = (m[`${r.job.kind}(${r.job.model.replace("claude-", "")})`] ?? 0) + 1), m), {});
      console.log(`[${name}] 送る ${reqs.length}件 ${JSON.stringify(kinds)}、入力 ${(chars / 1e4).toFixed(1)}万字`);
      if (args.dryRun) {
        await writeFile(path.join(ROOT, "data", "bundle", "dry-run-request.json"), JSON.stringify(reqs[0].params, null, 2));
        console.log(`対象の組 ${targets.length}（時期に分ける組 ${targets.filter((c) => c.parts.length > 1).length}）、${(targets.reduce((s, c) => s + c.chars, 0) / 1e4).toFixed(0)}万字`);
        console.log("--dry-run なので送らない（時期ごとのまとめを1つにする2回目の分は、1回目が終わるまで出ない）");
        return;
      }
      if (args.probe) {
        const r = reqs.filter((x) => x.job.kind === "cell").reduce((a, b) => (b.params.messages[0].content.length < a.params.messages[0].content.length ? b : a));
        console.log(`1件だけ送る: ${r.job.cell}（${r.params.messages[0].content.length}字）`);
        const msg = await client.messages.stream(r.params).finalMessage(); // 出力の上限が大きいと、SDK はストリーミングを求める
        console.log(`stop_reason: ${msg.stop_reason}、model: ${msg.model}、usage: ${JSON.stringify(msg.usage)}、料金の目安（通常の値段）: $${(usageCost(r.job.model, msg.usage) * 2).toFixed(3)}`);
        const out = JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
        const c = cells.get(r.job.cell);
        console.log(renderMd(c, out, { model: msg.model, prompt: PROMPT_VERSION }, recById));
        const bad = check(out, new Set(c.recs.map((x) => x.id)), c.recs.length);
        console.log(bad.length ? `形式チェックに落ちた: ${bad.join("／")}` : "形式チェックに合格");
        return;
      }
      const batch = await client.messages.batches.create({ requests: reqs.map(({ custom_id, params }) => ({ custom_id, params })) });
      batchId = batch.id;
      jobs = Object.fromEntries(reqs.map((r) => [r.custom_id, r.job]));
      await appendFile(batchLog, JSON.stringify({ batch_id: batchId, created: new Date().toISOString(), trial: args.trial, select, model: args.model, fallback: args.fallback, effort: args.effort, tag: args.tag, prompt: PROMPT_VERSION, count: reqs.length, jobs }) + "\n");
      console.log(`[${name}] 送った: ${batchId}（止めても node --env-file=.env pipeline/06_bundle.mjs --collect ${batchId} で結果を取って続けられる）`);
    }

    for (;;) {
      const b = await client.messages.batches.retrieve(batchId);
      const n = b.request_counts;
      console.log(`[${name}] ${new Date().toLocaleTimeString("ja-JP")} ${b.processing_status}: 処理中 ${n.processing}、成功 ${n.succeeded}、失敗 ${n.errored}`);
      if (b.processing_status === "ended") break;
      await sleep(60_000);
    }

    const errs = [];
    let sum = 0;
    for await (const r of await client.messages.batches.results(batchId)) {
      const job = jobs[r.custom_id];
      if (!job) continue;
      if (r.result.type !== "succeeded") {
        errs.push({ ...job, reason: `バッチ: ${r.result.type}`, detail: r.result.type === "errored" ? r.result.error : null });
        continue;
      }
      const msg = r.result.message;
      const u = msg.usage;
      const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cost: usageCost(job.model ?? args.model, u) };
      sum += usage.cost;
      if (msg.stop_reason !== "end_turn") {
        errs.push({ ...job, reason: `stop_reason: ${msg.stop_reason}`, detail: msg.stop_details ?? null, cost: usage.cost });
        continue;
      }
      const e = await save(job, msg, usage);
      if (e) errs.push({ ...job, ...e, cost: usage.cost });
    }
    if (errs.length) await write(errFile, (existsSync(errFile) ? await readFile(errFile, "utf8") : "") + errs.map((x) => JSON.stringify({ ...x, batch_id: batchId, at: new Date().toISOString() })).join("\n") + "\n");
    console.log(`[${name}] 受け取った。失敗 ${errs.length}件${errs.length ? `（${path.relative(ROOT, errFile)}。次の回で送り直す）` : ""}。この回の料金の目安 $${sum.toFixed(2)}`);
  }

  const done = targets.filter((c) => existsSync(cellFile(c)));
  let total = 0;
  for (const c of done) total += (await readJson(cellFile(c))).usage.cost;
  const failed = existsSync(errFile) ? (await readJsonl(errFile)).filter((e) => targets.some((c) => c.key === e.cell)).reduce((s, e) => s + (e.cost ?? 0), 0) : 0;
  console.log(`[${name}] まとめた組 ${done.length}/${targets.length}、料金の目安 $${total.toFixed(2)}（ほかに失敗した回の分 $${failed.toFixed(2)}）`);
  if (done.length < targets.length) console.log(`まとまっていない組: ${targets.filter((c) => !existsSync(cellFile(c))).map((c) => c.key).join("、")}`);
}

// 比べ合わせのスクリプト（06b）が関数だけを読み込むときは、main を動かさない
if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
