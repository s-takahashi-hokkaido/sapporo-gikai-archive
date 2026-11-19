#!/usr/bin/env node
// 工程3 T1: 会議録の Markdown（data/md）を発言単位に分け、発言・会議・発言者の一覧を作る。
// 設計: docs/工程3の設計.md
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/03a_speeches.mjs
//
// 出力（data/struct/）:
//   speeches/<年>.jsonl  発言。1つの HUID が1行（huid, file, seq, date, kind, mark, role, name, title, note, head, text, chars）
//   meetings.jsonl       会議1日分ごとの目録（会期、任期、委員会名、閲覧URL など）
//   speakers.jsonl       任期×氏名ごとの発言者の一覧（会派の名簿の漏れを見つけるのに使う）
//
// 毎回すべて作り直す。何度実行しても同じ結果になる。最後に検証の件数を出す。

import { readdir, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMd, termOf, sessionOf, committeeOf, normalizeName } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const MD = path.join(ROOT, "data", "md");
const OUT = path.join(ROOT, "data", "struct");
const SP = "　"; // 全角空白

// ---------- 発言者の読み取り ----------
// 議員側の役職。後ろに「（関連）」などの括弧書きが付くことがある
const SIDE_TITLE = /^(議員|委員|議長|副議長|臨時議長|仮議長|委員長|副委員長|臨時委員長|仮委員長|分科会長|副分科会長)(?:（([^）]+)）)?$/;
const CHAIR_TITLE = /^(議長|副議長|臨時議長|仮議長|委員長|副委員長|臨時委員長|仮委員長|分科会長|副分科会長)$/;

export function roleOf(title) {
  if (title == null) return null;
  if (CHAIR_TITLE.test(title)) return "chair";
  if (title === "議員" || title === "委員") return "member";
  return "official";
}

// 発言の1行目から、記号・氏名・役職を読む。読めなければ title と name が null
// joined が true のものは、姓と役職が続いていて分けられず、title に姓ごと入れている
export function parseSpeaker(firstLine) {
  const mark = firstLine[0];
  const s = firstLine.slice(1);
  const out = (title, name, note, headLen, joined = false) => ({ mark, title, name: normalizeName(name), note: note ?? null, head: mark + s.slice(0, headLen), joined });
  let m;
  // 本会議: 「議長（飯島弘之）　」「市長（秋元克広）　」。括弧の後ろに空白がないこともある
  if ((m = s.match(/^([^\s　（）]+)（([^（）]+)）　?/))) return out(m[1], m[2], null, m[0].replace(/　$/, "").length);
  // 本会議: 「川田ただひさ議員　」
  if ((m = s.match(/^([^\s　（）]+?)議員　/))) return out("議員", m[1], null, m[0].length - 1);

  // 委員会: 「氏名　役職　　本文」。役職の後ろの空白は普通2つ、たまに1つ
  const tokens = s.split(SP);
  const headOf = (n) => tokens.slice(0, n).join(SP).length;
  // 議員側: 役職の語を探す。氏名に空白が入ることがある（「佐藤　綾　委員」）
  for (let i = 1; i <= 3 && i < tokens.length; i++) {
    const t = tokens[i].match(SIDE_TITLE);
    if (t) return out(t[1], tokens.slice(0, i).join(""), t[2], headOf(i + 1));
  }
  // 答弁者側: 「姓　役職　　本文」。役職の後ろがすぐ改行のこともある（1行目が「姓　役職」だけ）
  const TITLE_END = /(長|者|監|官|理事|参事|主幹|担当|委員|部長|課長)(（[^）]+）)?$/;
  if (tokens.length >= 3 && tokens[0] && tokens[1] && tokens[2] === "") return out(tokens[1], tokens[0], null, headOf(2));
  if (tokens.length === 2 && tokens[0] && TITLE_END.test(tokens[1]) && tokens[1].length <= 30) return out(tokens[1], tokens[0], null, headOf(2));
  // 答弁者側で、役職の後ろの空白が1つ: 役職らしい語尾のときだけ
  if (tokens.length >= 3 && tokens[0] && TITLE_END.test(tokens[1])) return out(tokens[1], tokens[0], null, headOf(2));
  // 姓と役職のあいだに空白がない（「中出危機管理対策部長　本文」）: 分けられないので、役職に姓ごと入れる
  if (mark === "◎" && tokens.length >= 2 && TITLE_END.test(tokens[0])) return out(tokens[0], null, null, headOf(1), true);
  return { mark, title: null, name: null, note: null, head: null, joined: false };
}

// ---------- 本体 ----------
const flat = (s) => s.replace(/\n/g, "");

async function writeAtomic(p, text) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(`${p}.part`, text);
  await rename(`${p}.part`, p);
}

async function main() {
  const years = (await readdir(MD)).filter((d) => /^\d{4}$/.test(d)).sort();
  const meetings = [];
  const speakers = new Map();
  const seenHuid = new Map();
  const report = {
    unparsed: [],
    joined: [],
    markRole: [],
    huidCount: [],
    huidDup: [],
    huidOrder: [],
    lossless: [],
    noSession: [],
    noTerm: [],
  };
  let totalSpeeches = 0;

  for (const year of years) {
    const files = (await readdir(path.join(MD, year))).filter((f) => /_k\d_\d+\.md$/.test(f));
    // 1日分ずつ読む（本文は年の分だけ持つ）
    const docs = [];
    for (const f of files) {
      const file = `${year}/${f}`;
      const { meta, body } = await readMd(path.join(MD, year, f));
      docs.push({ file, meta, body, kindNo: Number(f.match(/_k(\d)_/)[1]) });
    }
    docs.sort((a, b) => a.meta.date.localeCompare(b.meta.date) || a.meta.fino - b.meta.fino);

    // 本会議の会期の期間（委員会の会期を日付で決めるため）
    const ranges = new Map();
    for (const d of docs) {
      const s = d.kindNo !== 3 ? sessionOf(d.meta.meeting, d.meta.date) : null;
      if (!s) continue;
      const r = ranges.get(s) ?? { from: d.meta.date, to: d.meta.date };
      if (d.meta.date < r.from) r.from = d.meta.date;
      if (d.meta.date > r.to) r.to = d.meta.date;
      ranges.set(s, r);
    }
    // 臨時会と定例会が重なることはないが、重なったら定例会を優先する
    const sessionByDate = (date) => {
      const hits = [...ranges].filter(([, r]) => r.from <= date && date <= r.to).map(([s]) => s);
      return hits.find((s) => s.endsWith("定")) ?? hits[0] ?? null;
    };

    const lines = [];
    for (const { file, meta, body, kindNo } of docs) {
      const issue = (meta.label ?? "").split("-").pop() || null;
      const term = termOf(meta.date);
      const session = kindNo !== 3 ? sessionOf(meta.meeting, meta.date) : sessionByDate(meta.date);
      const { committee, committeeType } = kindNo === 3 ? committeeOf(meta.meeting) : { committee: null, committeeType: null };
      if (kindNo !== 3 && !session) report.noSession.push(`${file}: ${meta.meeting}`);
      if (!term) report.noTerm.push(`${file}: ${meta.date}`);

      const parts = body.split(/<!-- HUID(\d+) -->\n/);
      const count = (parts.length - 1) / 2;
      if (count !== meta.speeches) report.huidCount.push(`${file}: 前付け ${meta.speeches} / HUID ${count}`);

      // 無損失の照合: 前置きと発言をつなぐと、改行を除いて本文に戻る
      const blocks = [];
      for (let i = 1; i < parts.length; i += 2) blocks.push(parts[i + 1]);
      if (flat(parts[0] + blocks.join("")) !== flat(body.replace(/<!-- HUID\d+ -->\n/g, ""))) report.lossless.push(file);

      let prev = -1;
      for (let i = 1, seq = 1; i < parts.length; i += 2, seq++) {
        const huid = Number(parts[i]);
        const text = parts[i + 1].replace(/\n+$/, "").split("\n\n").join("\n");
        if (text.includes("<!--")) report.lossless.push(`${file}: HUID${huid} に注記が混ざっている`);
        if (seenHuid.has(huid)) report.huidDup.push(`HUID${huid}: ${seenHuid.get(huid)} と ${file}`);
        seenHuid.set(huid, file);
        if (huid <= prev) report.huidOrder.push(`${file}: HUID${prev} の次が HUID${huid}`);
        prev = huid;

        const sp = parseSpeaker(text.split("\n")[0]);
        const role = roleOf(sp.title);
        if (!sp.title) report.unparsed.push(`${file} HUID${huid}: ${text.slice(0, 40)}`);
        else if (sp.joined) report.joined.push(`${file} HUID${huid}: ${sp.head}`);
        else if ((sp.mark === "◆" && role === "official") || (sp.mark === "◎" && role !== "official") || (sp.mark === "○" && role !== "chair"))
          report.markRole.push(`${file} HUID${huid}: ${sp.head}`);

        lines.push(JSON.stringify({ huid, file, seq, date: meta.date, kind: meta.kind, mark: sp.mark, role, name: sp.name, title: sp.title, note: sp.note, head: sp.head, text, chars: text.length }));
        totalSpeeches++;

        // 発言者の一覧。議長・委員長も議員なので、議員側（member）にまとめる
        if (sp.name && term) {
          const side = role === "official" ? "official" : "member";
          const key = `${term}\t${side}\t${sp.name}`;
          const a = speakers.get(key) ?? { term, side, name: sp.name, count: 0, titles: {}, kinds: {}, first: meta.date, last: meta.date, sample: huid };
          a.count++;
          a.titles[sp.title] = (a.titles[sp.title] ?? 0) + 1;
          a.kinds[meta.kind] = (a.kinds[meta.kind] ?? 0) + 1;
          if (meta.date > a.last) a.last = meta.date;
          speakers.set(key, a);
        }
      }

      meetings.push({
        file, kind: meta.kind, fino: meta.fino, meeting: meta.meeting, label: meta.label, issue, date: meta.date,
        session, term, committee, committeeType, viewer: meta.viewer, speeches: count,
      });
    }
    await writeAtomic(path.join(OUT, "speeches", `${year}.jsonl`), lines.join("\n") + "\n");
    console.log(`[${year}] 会議 ${docs.length} 件 / 発言 ${lines.length} 件`);
  }

  await writeAtomic(path.join(OUT, "meetings.jsonl"), meetings.map((m) => JSON.stringify(m)).join("\n") + "\n");
  const sp = [...speakers.values()].sort((a, b) => a.term.localeCompare(b.term) || a.side.localeCompare(b.side) || b.count - a.count);
  await writeAtomic(path.join(OUT, "speakers.jsonl"), sp.map((s) => JSON.stringify(s)).join("\n") + "\n");

  const members = sp.filter((s) => s.side === "member");
  console.log(`\n完了: 会議 ${meetings.length} 件 / 発言 ${totalSpeeches} 件 / 議員側の発言者 ${members.length} 人・任期 / 出力 data/struct/`);
  const rows = [
    ["発言者を読み取れない", report.unparsed],
    ["HUID の数が前付けの発言数と違う", report.huidCount],
    ["HUID が重複している", report.huidDup],
    ["HUID がファイルの中で増えていない", report.huidOrder],
    ["無損失の照合に失敗", report.lossless],
    ["本会議なのに会期が決まらない", report.noSession],
    ["任期が決まらない", report.noTerm],
    ["姓と役職を分けられない（title に姓ごと入れた。name は空）", report.joined],
    ["記号と役職が合わない（議員提出の議案で議員が◎で答弁する場合や、原本の誤り。role は役職で決めている）", report.markRole],
  ];
  for (const [label, list] of rows) {
    console.log(`${label}: ${list.length} 件`);
    for (const l of list.slice(0, 20)) console.log(`  ${l}`);
    if (list.length > 20) console.log(`  ほか ${list.length - 20} 件`);
  }
  if (report.unparsed.length || report.huidCount.length || report.huidDup.length || report.lossless.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  });
}
