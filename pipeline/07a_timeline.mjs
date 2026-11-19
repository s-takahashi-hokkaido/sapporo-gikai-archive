#!/usr/bin/env node
// 年表: 工程5の記録を、話題ごとに日付順に並べる（AI は使わない）。仕上がりの topics/<話題>/年表.md になる。
// 作り方: docs/作り方.md の「年表」（全市の年表は Git に入れない。docs/動かし方.md で作る）
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/07a_timeline.mjs        # すべての話題の年表を作り直す（数秒）
//
// 入力: records/<年>.jsonl（工程5）、pipeline/topics.csv
// 出力: topics/<話題>/年表.md
// - 主の話題の記録と、副の話題として付いた記録の両方を載せる（副は「（副）」と書く。docs/作り方.md の工程4）
// - 任期ごとに見出しを立て、日付順に並べる。2003-2007 の任期は「2007年1〜4月（前の任期の終わり）」として載せる
// - 要旨は AI が会議録を要約したもので、原文ではない。「約束」の「」の中だけが原文。そのことを各ファイルの頭に書く

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCsv } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");

export const termTitle = (t) => (t === "2003-2007" ? "2007年1〜4月（前の任期の終わり）" : `${t.slice(0, 4)}年5月〜${t.slice(5)}年4月`);
export const where = (r) => (r.kind === "委員会" ? r.committee : `本会議（${r.kind}）`);
export const oneLine = (s) => (s ?? "").replace(/\s*\n\s*/g, " ");
// GitHub が見出しに付けるアンカー（英字は小文字、文字・数字・空白・ハイフン・下線のほかは消し、空白はハイフン）
export const anchor = (h) => h.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
// 記録の並び（日付、まとまり、項目の順）
const num = (id) => id.split("-").map(Number);
export const byDate = (a, b) => a.date.localeCompare(b.date) || num(a.id)[0] - num(b.id)[0] || num(a.id)[1] - num(b.id)[1];

export async function loadAllRecords() {
  const dir = path.join(ROOT, "records");
  const records = [];
  for (const f of (await readdir(dir)).filter((f) => /^\d{4}\.jsonl$/.test(f)).sort())
    for (const l of (await readFile(path.join(dir, f), "utf8")).split("\n")) if (l.trim()) records.push(JSON.parse(l));
  return records;
}

export function entry(r, sub) {
  const who = r.questioner ? `${r.questioner}（${r.faction ?? "会派不明"}）` : "";
  const head = [where(r), r.type, who].filter(Boolean).join("・");
  const area = [...r.areas, ...r.places].join("、");
  const lines = [`- **${r.date}** ${sub ? "（副）" : ""}${head}［${area}］ [会議録](${r.url})`, `  - **${oneLine(r.title)}**${sub ? `（主の話題: ${r.topic}）` : ""}`, `  - 問: ${oneLine(r.question)}`, `  - 答: ${oneLine(r.answer)}`];
  if (r.commitments.length) lines.push(`  - 約束: ${r.commitments.map((c) => `${c.speaker}「${oneLine(c.quote)}」`).join("／")}`);
  return lines.join("\n");
}

async function main() {
  const topics = parseCsv(await readFile(path.join(here, "topics.csv"), "utf8"));
  const records = await loadAllRecords();

  const byTopic = new Map(topics.map((t) => [t["話題"], []]));
  for (const r of records) {
    byTopic.get(r.topic)?.push({ r, sub: false });
    for (const s of r.sub_topics ?? []) byTopic.get(s)?.push({ r, sub: true });
  }
  let files = 0, bytes = 0;
  for (const t of topics) {
    const name = t["話題"];
    const rows = byTopic.get(name).sort((a, b) => byDate(a.r, b.r));
    const terms = [...new Set(rows.map((x) => x.r.term))].sort();
    const main = rows.filter((x) => !x.sub).length;
    const out = [
      `# ${name} 年表`,
      "",
      `工程5の記録（会議録の質問と答弁を、項目ごとに AI が要約したもの）を日付順に並べた。主の話題の記録 ${main}件と、副の話題としてこの話題にかかる記録 ${rows.length - main}件（「（副）」と書いたもの）。` +
        "問・答は要約で、原文ではない。「約束」の「」の中だけが会議録の原文。数字や答弁を人前で使う前に、[会議録] のリンクで原文を確かめる。",
      "",
      `範囲: ${t["範囲"]}`,
      "",
      `| 任期 | 主 | 副 |`,
      `|---|---|---|`,
      ...terms.map((p) => `| [${termTitle(p)}](#${anchor(termTitle(p))}) | ${rows.filter((x) => x.r.term === p && !x.sub).length} | ${rows.filter((x) => x.r.term === p && x.sub).length} |`),
    ];
    for (const p of terms) out.push("", `## ${termTitle(p)}`, "", ...rows.filter((x) => x.r.term === p).map((x) => entry(x.r, x.sub)));
    const text = out.join("\n") + "\n";
    const file = path.join(ROOT, "topics", name, "年表.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    files++;
    bytes += Buffer.byteLength(text);
  }
  console.log(`年表を書いた: ${files}話題、計 ${(bytes / 1e6).toFixed(1)}MB（topics/<話題>/年表.md）`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
