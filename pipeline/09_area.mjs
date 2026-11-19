#!/usr/bin/env node
// 区から辿る: 工程5の記録のうち、地域にその区が付いたものを集め、区の入口（話題ごとの件数、区で絞った年表、地名の一覧、最近の記録）を作る。
// AI は使わない（API の料金はかからない）。記録（records/）があれば、誰でも作り直せる。
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/09_area.mjs --area 北区     # areas/北区/ を作る（数秒）
//   node pipeline/09_area.mjs --all           # 10区すべてと、10区の一覧 areas/README.md
//   node pipeline/09_area.mjs --list          # 区ごとの記録の数を見る（何も書かない）
//
// 入力: records/<年>.jsonl（工程5）、pipeline/topics.csv、topics/<話題>/history.json（20年のまとめがある話題へのリンクに使う）
// 出力: areas/<区>/README.md（入口）、areas/<区>/<話題>.md（その区の記録の年表）、areas/<区>/地名.md（地名ごとの記録）、areas/README.md（--all のとき）
// - 地域は工程5で AI が付けたもの。「全市」の話の中で区に具体的に触れたものにも区が付く（docs/作り方.md の工程4）
// - 主の話題の記録と、副の話題として付いた記録の両方を載せる（副は「（副）」）
// - GitHub の画面で Markdown として表示できるよう、どのファイルも38万バイト未満にする。超えるものは、並びのまま <名前>.md、<名前>2.md… に分け、
//   各ファイルの頭と終わりに前後へのリンクを置く。2026年11月19日に公開して確かめると、GitHub は 396,488バイトのファイルは表示し、
//   420,115バイト以上のファイルは表示しなかった（ページの richTextTruncated が true になり、Markdown として描画されない）
// - 作り直すときは、そのまま流せば上書きする（区のフォルダを消してから書く）

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./lib.mjs";
import { anchor, byDate, entry, loadAllRecords, oneLine, termTitle } from "./07a_timeline.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const WARDS = ["中央区", "北区", "東区", "白石区", "厚別区", "豊平区", "清田区", "南区", "西区", "手稲区"];
const PLACE_MIN = 2; // 地名.md に見出しを立てる記録の数
const RECENT = 30; // 入口に載せる最近の記録の数
const MAX_BYTES = 380_000; // 1ファイルの上限（GitHub の画面で Markdown として表示できるのは約40万バイトまで。上の説明）
const HEAD_ROOM = 20_000; // ファイルの頭と終わり（説明、任期の表、前後へのリンク）に取っておく分

function parseArgs(argv) {
  const a = { area: null, all: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--area") a.area = argv[++i];
    else if (k === "--all") a.all = true;
    else if (k === "--list") a.list = true;
    else throw new Error(`知らないオプション: ${k}`);
  }
  if ([Boolean(a.area), a.all, a.list].filter(Boolean).length !== 1) throw new Error("--area <区>、--all、--list のどれか1つを付ける");
  if (a.area && !WARDS.includes(a.area)) throw new Error(`区の名前は ${WARDS.join("、")} のどれか（「北区」のように「区」まで書く）`);
  return a;
}

const enc = (s) => encodeURI(s).replace(/#/g, "%23").replace(/\(/g, "%28").replace(/\)/g, "%29");
const bytesOf = (s) => Buffer.byteLength(s);
const short = (r) => `**${r.date}** ${oneLine(r.title)}（${r.topic}${r.questioner ? `、${r.questioner}・${r.faction ?? "会派不明"}` : ""}） [会議録](${r.url})`;
// 分けたファイルの名前: 1つめは <名前>.md、2つめから <名前>2.md、<名前>3.md…
const partFile = (base, i) => `${base}${i ? i + 1 : ""}.md`;

// 見出しごとの項目の並びを、並びのまま MAX_BYTES 未満のファイルに詰める。
// sections: [{ title, intro: [行], items: [{ key, text }] }]。見出しの途中で分かれたら、次のファイルに「（続き）」の見出しを立てる。
// 返り値: pages（ファイルごとの本文の行）、where（項目の key → ファイルの番号）、start（見出し → 最初に出るファイルの番号）
function paginate(sections) {
  const budget = MAX_BYTES - HEAD_ROOM;
  const pages = [];
  const where = new Map();
  const start = new Map();
  let cur = null;
  for (const s of sections) {
    s.items.forEach((item, i) => {
      const head = i === 0 ? ["", `## ${s.title}`, "", ...s.intro] : [];
      let lines = [...head, item.text];
      if (cur && cur.size + bytesOf(lines.join("\n")) + 1 > budget) cur = null;
      if (!cur) {
        cur = { lines: [], size: 0 };
        pages.push(cur);
        if (i > 0) lines = ["", `## ${s.title}（続き）`, "", item.text];
      }
      if (i === 0) start.set(s.title, pages.length - 1);
      cur.lines.push(...lines);
      cur.size += bytesOf(lines.join("\n")) + 1;
      if (item.key != null) where.set(item.key, pages.length - 1);
    });
  }
  if (!pages.length) pages.push({ lines: [], size: 0 });
  return { pages: pages.map((p) => p.lines), where, start };
}

// 分けたファイルの前後へのリンク（分けていなければ何も出さない）
function pager(base, i, n) {
  if (n <= 1) return [];
  const prev = i > 0 ? `前: [${partFile(base, i - 1)}](${enc(partFile(base, i - 1))})` : null;
  const next = i < n - 1 ? `次: [${partFile(base, i + 1)}](${enc(partFile(base, i + 1))})` : null;
  return ["", `> ${n}つのファイルに分けた${i + 1}つめ。${[prev, next].filter(Boolean).join("　")}`];
}

async function writePages(dir, base, pages, headOf) {
  let bytes = 0;
  for (let i = 0; i < pages.length; i++) {
    const text = [...headOf(i), ...pager(base, i, pages.length), ...pages[i], ...pager(base, i, pages.length)].join("\n") + "\n";
    if (bytesOf(text) >= MAX_BYTES) throw new Error(`${partFile(base, i)} が上限（${MAX_BYTES}バイト）を超えた（${bytesOf(text)}バイト）。HEAD_ROOM を見直す`);
    await writeFile(path.join(dir, partFile(base, i)), text);
    bytes += bytesOf(text);
  }
  return bytes;
}

async function writeArea(ward, records, topics) {
  const dir = path.join(ROOT, "areas", ward);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const mine = records.filter((r) => r.areas.includes(ward)).sort(byDate);

  // 話題ごと（主の話題と、副の話題）
  const rows = new Map(topics.map((t) => [t["話題"], []]));
  for (const r of mine) {
    rows.get(r.topic)?.push({ r, sub: false });
    for (const s of r.sub_topics ?? []) rows.get(s)?.push({ r, sub: true });
  }
  const table = [];
  const recFile = new Map(); // 話題 + 記録の id → その記録が載る年表のファイル（地名の一覧からのリンクに使う）
  const split = [];
  let bytes = 0;
  for (const t of topics) {
    const name = t["話題"];
    const xs = rows.get(name);
    if (!xs.length) continue;
    xs.sort((a, b) => byDate(a.r, b.r));
    const main = xs.filter((x) => !x.sub);
    const terms = [...new Set(xs.map((x) => x.r.term))].sort();
    const { pages, where, start } = paginate(terms.map((p) => ({ title: termTitle(p), intro: [], items: xs.filter((x) => x.r.term === p).map((x) => ({ key: x.r.id, text: entry(x.r, x.sub) })) })));
    for (const [id, i] of where) recFile.set(`${name}\t${id}`, partFile(name, i));
    const termLink = (p) => `${start.get(termTitle(p)) ? enc(partFile(name, start.get(termTitle(p)))) : ""}#${anchor(termTitle(p))}`;
    const headOf = (i) =>
      i === 0
        ? [
            `# ${ward}の「${name}」 年表`,
            "",
            `工程5の記録のうち、地域に${ward}が付き、話題が「${name}」のもの（主の話題 ${main.length}件、副の話題としてかかるもの ${xs.length - main.length}件）を日付順に並べた。問・答は AI の要約で、原文ではない。「約束」の「」の中だけが会議録の原文。人前で使う前に、[会議録] のリンクで原文を確かめる。`,
            "",
            `- [${ward}の入口に戻る](README.md)`,
            existsSync(path.join(ROOT, "topics", name, "history.json")) ? `- この話題の20年の経緯（札幌市全体）: [${name}](../../topics/${enc(name)}/README.md)` : null,
            `- 範囲: ${t["範囲"]}`,
            "",
            "| 任期 | 主 | 副 |",
            "|---|---|---|",
            ...terms.map((p) => `| [${termTitle(p)}](${termLink(p)}) | ${xs.filter((x) => x.r.term === p && !x.sub).length} | ${xs.filter((x) => x.r.term === p && x.sub).length} |`),
          ].filter((l) => l !== null)
        : [`# ${ward}の「${name}」 年表（${i + 1}）`, "", `- [${ward}の入口に戻る](README.md)　[任期の表](${enc(partFile(name, 0))})`];
    bytes += await writePages(dir, name, pages, headOf);
    if (pages.length > 1) split.push(`${name}.md（${pages.length}つ）`);
    table.push({ t, name, main: main.length, sub: xs.length - main.length, first: xs[0].r.date.slice(0, 4), last: xs.at(-1).r.date });
  }

  // 地名ごと
  const places = new Map();
  for (const r of mine) for (const p of new Set(r.places)) (places.get(p) ?? places.set(p, []).get(p)).push(r);
  const ps = [...places].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "ja"));
  const big = ps.filter(([, rs]) => rs.length >= PLACE_MIN);
  const small = ps.filter(([, rs]) => rs.length < PLACE_MIN);
  const topicsOf = (rs) => [...rs.reduce((m, r) => m.set(r.topic, (m.get(r.topic) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join("、");
  // 地名の一覧では、記録は会議録の URL（1件250字ほど）ではなく、その区の話題の年表へのリンクにする（ファイルを小さくするため）。
  // 会議録へのリンクは、話題の年表の同じ日付の記録にある
  const viaTopic = (r) => `**${r.date}** ${oneLine(r.title)}（[${r.topic}](${enc(recFile.get(`${r.topic}\t${r.id}`) ?? `${r.topic}.md`)})${r.questioner ? `、${r.questioner}・${r.faction ?? "会派不明"}` : ""}）`;
  const placeSections = big.map(([p, rs]) => ({ title: p, intro: [`${rs.length}件（${topicsOf(rs)}）`, ""], items: rs.map((r) => ({ text: `- ${viaTopic(r)}` })) }));
  if (small.length) placeSections.push({ title: "1件だけの地名", intro: [], items: small.map(([p, rs]) => ({ text: `- ${p}: ${viaTopic(rs[0])}` })) });
  const place = paginate(placeSections);
  const placeHead = (i) =>
    i === 0
      ? [
          `# ${ward}の記録に出てくる地名`,
          "",
          `工程5の記録のうち、地域に${ward}が付いたものの「地名」（会議録に出たとおりに AI が書き出したもの）ごとに、記録を日付順に並べた。${ward}の外の地名（札幌駅、大通 など）も、${ward}の話の中で出てきたものは載る。記録が${PLACE_MIN}件以上の地名 ${big.length}個に、記録の多い順に見出しを立て、1件だけの地名 ${small.length}個は最後にまとめた。各記録の（）の中の話題から、${ward}の話題の年表に飛べる。会議録へのリンクは、年表の同じ日付の記録にある。`,
          "",
          `- [${ward}の入口に戻る](README.md)`,
        ]
      : [`# ${ward}の記録に出てくる地名（${i + 1}）`, "", `- [${ward}の入口に戻る](README.md)`];
  bytes += await writePages(dir, "地名", place.pages, placeHead);
  if (place.pages.length > 1) split.push(`地名.md（${place.pages.length}つ）`);
  const placeLink = (p) => `${enc(partFile("地名", place.start.get(p) ?? 0))}#${enc(anchor(p))}`;

  // 入口
  const years = mine.map((r) => r.date.slice(0, 4));
  const pillars = table.filter((x) => x.t["柱"]); // 細かく分けた5分野（topics.csv の「柱」の列に値があるもの）
  const others = table.filter((x) => !x.t["柱"]);
  const trow = (x) =>
    `| ${x.t["分野"]} | [${x.name}](${enc(x.name)}.md) | ${x.main} | ${x.sub} | ${x.first}〜${x.last.slice(0, 4)} | ${x.last} | ${existsSync(path.join(ROOT, "topics", x.name, "history.json")) ? `[20年の経緯](../../topics/${enc(x.name)}/README.md)` : ""} |`;
  const thead = "| 分野 | 話題（" + ward + "の年表） | 主 | 副 | 年 | 最後の記録 | 札幌市全体 |\n|---|---|---|---|---|---|---|";
  const readme = [
    `# ${ward}から辿る札幌市議会（${years[0]}〜${years.at(-1)}年）`,
    "",
    `札幌市議会の会議録（本会議と委員会）を AI が項目ごとに要約した記録 ${records.length.toLocaleString()}件のうち、地域に${ward}が付いたもの ${mine.length.toLocaleString()}件を、話題ごと・地名ごとに並べた。話題の20年の流れ（札幌市全体）は、各話題の「20年の経緯」から読める。`,
    "",
    "> 要旨は AI が会議録を要約したもので、原文ではない。数字や答弁を人前で使う前に、各記録の [会議録] のリンクで原文を確かめる。地域も AI が付けたもので、「全市」の話の中で" + ward + "に具体的に触れたものにも付いている。会議録は2026年6月ごろの分まで。",
    "",
    "- 話題の一覧（札幌市全体）: [topics/README.md](../../topics/README.md)",
    "- ほかの区: [10区の一覧](../README.md)",
    `- 地名ごと: [${ward}の記録に出てくる地名](地名.md)（${big.length}個${place.pages.length > 1 ? `。${place.pages.length}つのファイルに分けた` : ""}。多いもの: ${big.slice(0, 8).map(([p, rs]) => `[${p}](${placeLink(p)})（${rs.length}件）`).join("、")}）`,
    "",
    `## 話題ごと（細かく分けた分野）`,
    "",
    "雪、子育て、交通、地域の担い手、AI・デジタルの5分野は、話題を細かく分けてある。「主」はその話題が主の記録、「副」はほかの話題が主で、この話題にもかかる記録の数。",
    "",
    thead,
    ...pillars.map(trow),
    "",
    "## 話題ごと（ほかの分野）",
    "",
    thead,
    ...others.map(trow),
    "",
    `## 最近の記録（${RECENT}件）`,
    "",
    ...mine.slice(-RECENT).reverse().map((r) => `- ${short(r)}`),
    "",
    "## 作り方",
    "",
    "会議録を AI が要約した記録から、地域に" + ward + "が付いたものをプログラムで集めて並べた（ここでは AI は使っていない）。作り直し方は [docs/動かし方.md](../../docs/動かし方.md)。",
  ].join("\n") + "\n";
  await writeFile(path.join(dir, "README.md"), readme);
  bytes += bytesOf(readme);
  return { ward, records: mine.length, topics: table.length, places: ps.length, mb: bytes / 1e6, split };
}

// 10区の一覧（--all のとき）
async function writeIndex(results, total) {
  const lines = [
    "# 区から辿る",
    "",
    `札幌市議会の会議録（本会議と委員会）を AI が項目ごとに要約した記録 ${total.toLocaleString()}件を、地域（区）ごとに、話題ごと・地名ごとに並べた。区の名前から入口を開く。`,
    "",
    "> 地域は AI が付けたもので、「全市」の話の中で区に具体的に触れたものにも、その区が付いている。1つの記録に2つ以上の区が付くこともあるので、区ごとの数を足しても記録の数にはならない。会議録は2026年6月ごろの分まで。",
    "",
    "| 区 | 記録の数 | 話題の数 | 地名の数 |",
    "|---|---|---|---|",
    ...results.map((x) => `| [${x.ward}](${enc(x.ward)}/README.md) | ${x.records.toLocaleString()} | ${x.topics} | ${x.places.toLocaleString()} |`),
    "",
    "- 話題の一覧（札幌市全体）: [topics/README.md](../topics/README.md)",
    "- 作り直し方: [docs/動かし方.md](../docs/動かし方.md)",
  ];
  await writeFile(path.join(ROOT, "areas", "README.md"), lines.join("\n") + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const topics = parseCsv(await readFile(path.join(here, "topics.csv"), "utf8"));
  const records = await loadAllRecords();
  if (args.list) {
    for (const w of WARDS) console.log(`${w}\t${records.filter((r) => r.areas.includes(w)).length}件`);
    return;
  }
  const results = [];
  for (const w of args.all ? WARDS : [args.area]) {
    const x = await writeArea(w, records, topics);
    results.push(x);
    console.log(`areas/${x.ward}/ を作った: 記録 ${x.records}件、話題 ${x.topics}、地名 ${x.places}個、計 ${x.mb.toFixed(1)}MB${x.split.length ? `。分けたもの: ${x.split.join("、")}` : ""}`);
  }
  if (args.all) {
    await writeIndex(results, records.length);
    console.log("areas/README.md（10区の一覧）を書いた");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
