#!/usr/bin/env node
// 会議録の原本（data/raw/<年>/*.html、Shift_JIS）を Markdown（data/md/<年>/*.md、UTF-8）に変換する。
// 本文は書き換えない。HTML のタグを外して改行に直し、発言ごとに空行で区切るだけ。
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/02_to_markdown.mjs            変換していない原本と、原本のほうが新しいものだけ変換する
//   node pipeline/02_to_markdown.mjs --force    すべて変換し直す（このスクリプトを直したとき）
//
// ダウンロード中に動かしてもよい（書き込み途中の *.part は読まない）。何度実行しても同じ結果になる。
//
// 出力の形:
//   ---                       ← 目録の情報（会議名、日付、閲覧URL など）
//   # <会議名> <号>
//   <冒頭（出席者など）>        ← 原本のまま
//   <!-- HUID12345 -->        ← 発言の番号（会議録システムの発言ID）
//   ◆○○議員　……             ← 発言の本文。原本のまま。原本の1行ごとに空行を挟む
//
// 変換のたびに、原本からタグを外した文字列と、Markdown から付け足した部分を除いた文字列が
// 1文字残らず一致することを確かめる。一致しないファイルは「不一致」として最後に一覧を出す。

import { readFile, writeFile, readdir, stat, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseList } from "./01_download.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const RAW = path.join(ROOT, "data", "raw");
const MD = path.join(ROOT, "data", "md");
const KIND_NAMES = { 1: "定例会", 2: "臨時会", 3: "委員会" };
const SJIS = new TextDecoder("shift_jis");

const force = process.argv.includes("--force");

// ---------- 目録 ----------
// 一覧ページ（lists/）は本文より先に保存されるので、ダウンロード中の年も情報が取れる。
// 目録（manifest/）は年・種別ごとに取得が終わってから書かれるので、発言数の照合にだけ使う。
const listCache = new Map();
async function listRows(year, kind) {
  const key = `${year}-k${kind}`;
  if (!listCache.has(key)) {
    const rows = new Map();
    try {
      const html = SJIS.decode(await readFile(path.join(RAW, "lists", `${key}.html`)));
      for (const r of parseList(html, year).rows) rows.set(r.fino, r);
    } catch {}
    try {
      const lines = (await readFile(path.join(RAW, "manifest", `${key}.jsonl`), "utf8")).split("\n");
      for (const l of lines.filter(Boolean)) {
        const m = JSON.parse(l);
        rows.set(m.fino, { ...rows.get(m.fino), ...m });
      }
    } catch {}
    listCache.set(key, rows);
  }
  return listCache.get(key);
}

// ---------- 変換 ----------
// 原本の本文部分: <BODY> の中から、画面用の SCRIPT と FORM を除いたもの
function bodyOf(html) {
  return html
    .replace(/^[\s\S]*?<BODY[^>]*>/i, "")
    .replace(/<\/BODY>[\s\S]*$/i, "")
    .replace(/<SCRIPT[\s\S]*?<\/SCRIPT>/gi, "")
    .replace(/<FORM[\s\S]*?<\/FORM>/gi, "")
    .replace(/\r/g, "");
}

// 1ブロック（冒頭、または発言1件）を、タグを外した行の並びにする。
// Markdown で表示したときに行がつながらないよう、行と行の間に空行を入れる（原本の空行は1つにまとめる）。
// 行頭の全角空白は字下げなので残す（String.trim は全角空白も消すので使わない）
function blockText(html) {
  const text = html.replace(/<BR\s*\/?>/gi, "\n");
  const leftover = text.match(/<[^>]+>/);
  if (leftover) throw new Error(`想定していないタグ: ${leftover[0]}`);
  return text
    .split("\n")
    .filter((l) => l !== "")
    .join("\n\n");
}

function convert(html, meta) {
  const body = bodyOf(html);
  const blocks = body.split(/<P>/i);
  const out = [];
  let speeches = 0;
  for (const [i, raw] of blocks.entries()) {
    const anchor = raw.match(/^\s*<A NAME="(HUID\d+)"><\/A>/i);
    const rest = anchor ? raw.slice(anchor[0].length) : raw;
    const text = blockText(rest.replace(/<A NAME="HUID\d+"><\/A>/gi, ""));
    if (i === 0) {
      if (text) out.push(text); // 冒頭（会議名、出席者、目次など）
      continue;
    }
    if (!text) continue;
    speeches++;
    out.push((anchor ? `<!-- ${anchor[1]} -->\n` : "") + text);
  }

  const fm = [
    ["meeting", meta.meeting],
    ["label", meta.label],
    ["date", meta.date],
    ["kind", meta.kindName],
    ["fino", meta.fino],
    ["viewer", meta.viewerUrl],
    ["source", meta.source],
    ["speeches", speeches],
  ]
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`);
  const title = [meta.meeting, meta.label].filter(Boolean).join(" ");
  const md = `---\n${fm.join("\n")}\n---\n\n# ${title}\n\n${out.join("\n\n")}\n`;
  return { md, body, speeches };
}

// ---------- 照合 ----------
// 原本: タグを外した文字列。Markdown: 付け足した部分（前付け、見出し、HUID の注記）を除いた文字列。
// 改行の数だけは変わる（発言の区切りに空行を入れる）ので、改行を除いて比べる。
const flat = (s) => s.replace(/\n/g, "");
function verify(body, md) {
  const fromRaw = flat(body.replace(/<BR\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
  const fromMd = flat(
    md
      .replace(/^---\n[\s\S]*?\n---\n\n# [^\n]*\n/, "")
      .replace(/<!-- HUID\d+ -->\n/g, ""),
  );
  if (fromRaw === fromMd) return null;
  let i = 0;
  while (i < fromRaw.length && fromRaw[i] === fromMd[i]) i++;
  return `${i}文字目から違う: 原本「${fromRaw.slice(i, i + 30)}」/ md「${fromMd.slice(i, i + 30)}」`;
}

// Markdown として読むと意味が変わってしまう行（見出し、引用、箇条書き、表など）を数える。
// 本文は書き換えない方針なので、直さずに報告だけする
const MD_LINE_RE = /^(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|\||```|-{3,}\s*$|={3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/m;

// ---------- 本体 ----------
async function mtime(p) {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

async function main() {
  const years = (await readdir(RAW)).filter((d) => /^\d{4}$/.test(d)).sort();
  const total = { converted: 0, skipped: 0, mismatch: [], replacement: [], mdLike: [], noMeta: [], speakerDiff: [] };
  const index = [];

  for (const year of years) {
    const files = (await readdir(path.join(RAW, year))).filter((f) => f.endsWith(".html")).sort();
    let yearConverted = 0;
    for (const f of files) {
      const m = f.match(/^(.+)_k(\d)_(\d+)\.html$/);
      if (!m) continue;
      const [, datePart, kind, fino] = m;
      const rawPath = path.join(RAW, year, f);
      const mdPath = path.join(MD, year, f.replace(/\.html$/, ".md"));
      const row = (await listRows(Number(year), Number(kind))).get(Number(fino));
      if (!row) total.noMeta.push(`${year}/${f}`);
      const meta = {
        meeting: row?.meeting,
        label: row?.label,
        date: row?.date ?? (/^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : undefined),
        kindName: KIND_NAMES[kind],
        fino: Number(fino),
        viewerUrl: row?.viewerUrl,
        source: `data/raw/${year}/${f}`,
      };

      const upToDate = !force && (await mtime(mdPath)) >= (await mtime(rawPath));
      let speeches;
      if (upToDate) {
        total.skipped++;
        speeches = Number(((await readFile(mdPath, "utf8")).match(/^speeches: (\d+)$/m) || [])[1]);
      } else {
        const html = SJIS.decode(await readFile(rawPath));
        const { md, body, speeches: n } = convert(html, meta);
        speeches = n;
        const diff = verify(body, md);
        if (diff) total.mismatch.push(`${year}/${f}: ${diff}`);
        if (md.includes("�")) total.replacement.push(`${year}/${f}`);
        const mdBody = md.replace(/^---\n[\s\S]*?\n---\n\n# [^\n]*\n/, "");
        if (MD_LINE_RE.test(mdBody)) total.mdLike.push(`${year}/${f}: ${mdBody.match(MD_LINE_RE).input.split("\n").find((l) => MD_LINE_RE.test(l)).slice(0, 40)}`);
        if (row?.speakers !== undefined) {
          const marks = (mdBody.match(/^[○◆◎]/gm) || []).length;
          if (marks !== row.speakers) total.speakerDiff.push(`${year}/${f}: 目録 ${row.speakers} / md ${marks}`);
        }
        await mkdir(path.dirname(mdPath), { recursive: true });
        await writeFile(`${mdPath}.part`, md);
        await rename(`${mdPath}.part`, mdPath);
        total.converted++;
        yearConverted++;
      }
      index.push({ year, date: meta.date, kind: meta.kindName, meeting: meta.meeting, label: meta.label, file: `${year}/${f.replace(/\.html$/, ".md")}`, speeches });
    }
    console.log(`[${year}] ${files.length} 件（今回変換 ${yearConverted} 件）`);
  }

  // 目次: 年ごとに、会議の一覧を表にする
  const lines = ["# 会議録 Markdown の目次", "", `${index.length} 件。\`pipeline/02_to_markdown.mjs\` が作る（手で直さない）。`, ""];
  for (const year of years) {
    const rows = index.filter((r) => r.year === year);
    if (!rows.length) continue;
    lines.push(`## ${year}年（${rows.length}件）`, "", "| 日付 | 種別 | 会議 | 号 | 発言数 | ファイル |", "|---|---|---|---|---|---|");
    for (const r of rows.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.file.localeCompare(b.file)))
      lines.push(`| ${r.date ?? ""} | ${r.kind} | ${r.meeting ?? ""} | ${r.label ?? ""} | ${r.speeches ?? ""} | [${path.basename(r.file)}](${r.file}) |`);
    lines.push("");
  }
  await writeFile(path.join(MD, "index.md"), lines.join("\n"));

  console.log(`\n完了: 変換 ${total.converted} 件 / 変換済みで飛ばした ${total.skipped} 件 / 目次 data/md/index.md`);
  const report = [
    ["原本と内容が一致しない", total.mismatch],
    ["文字化け（U+FFFD）がある", total.replacement],
    ["発言数が目録と違う", total.speakerDiff],
    ["目録に見つからない（会議名などが空）", total.noMeta],
    ["Markdown の記号として読まれうる行がある（本文はそのまま）", total.mdLike],
  ];
  for (const [label, list] of report) {
    console.log(`${label}: ${list.length} 件`);
    for (const l of list.slice(0, 20)) console.log(`  ${l}`);
    if (list.length > 20) console.log(`  ほか ${list.length - 20} 件`);
  }
  if (total.mismatch.length || total.replacement.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
