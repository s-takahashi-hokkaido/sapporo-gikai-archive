#!/usr/bin/env node
// 工程3 T3: 会派の名簿（任期×氏名→会派）を作り、確かめる。
// 設計: docs/工程3の設計.md の「会派の名簿」
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/03c_members.mjs --fetch   外部の資料（札幌市議会の会派別名簿の過去の版）を Wayback Machine から取る
//   node pipeline/03c_members.mjs --draft   名簿の下書きを data/struct/members_draft.csv に書く（members.csv は上書きしない）
//   node pipeline/03c_members.mjs           pipeline/members/*.csv を、会議録と外部の資料に照らして確かめる
//
// 名簿の本体は pipeline/members/ の3つの CSV で、手で直す（Git で管理する）。
//   members.csv   term,name,faction,from,to,ward,source
//   factions.csv  faction,aliases,terms
//   aliases.csv   variant,name,source
//
// 根拠にするもの:
//   外部   札幌市議会の会派別名簿の過去の版（data/external/meibo/。--fetch で取る）。会派の正式名と所属議員、選出区。
//          2006〜2007年は vol3/02kaiha/ の2ページ、2009年11月からは meibo/meibo-kaiha.html。2007年8月〜2009年11月の版はない
//   会議録 本会議の出席議員・欠席議員の欄（その日の議員の全員）、目次の「氏名議員（会派）」（T2 の toc.jsonl も使う）、
//          発言の最初の文の「〜を代表し」（data/struct/speeches/）
//
// 入力: T1 の data/struct/{meetings,speakers}.jsonl と speeches/、T2 の data/struct/toc.jsonl（なければ目次の Markdown だけ読む）
// 出力: data/struct/member_evidence.jsonl  観測の一覧（どの日に、どの根拠で、どの会派だったか。確認用）
//       data/struct/members_draft.csv, factions_draft.csv（--draft のとき）
//
// 何度実行しても同じ結果になる。最後に検証の項目ごとの件数を出す。

import { readFile, readdir, writeFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { termOf, normalizeName, toHalfDigits as toHalf } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const MD = path.join(ROOT, "data", "md");
const STRUCT = path.join(ROOT, "data", "struct");
const EXT = path.join(ROOT, "data", "external", "meibo");
const MEMBERS = path.join(here, "members");

// ---------- 外部の資料（Wayback Machine） ----------
// 会派別名簿のページ。2004〜2007年は2ページに分かれていた（自民・民主と、そのほかの会派）
const PAGES = [
  { page: "vol3-1", url: "www.city.sapporo.jp/gikai/vol3/02kaiha/01jimin_minshu.htm" },
  { page: "vol3-2", url: "www.city.sapporo.jp/gikai/vol3/02kaiha/02sonota.htm" },
  { page: "kaiha", url: "www.city.sapporo.jp/gikai/meibo/meibo-kaiha.html" },
];
const LIVE = "https://www.city.sapporo.jp/gikai/meibo/meibo-kaiha.html";
const FIRST_NEEDED = "20061001"; // 会議録は2007年1月から。その時点で有効な版から取る
const USER_AGENT = "sapporo-gikai-archive/1.0 (personal research; 1 request per 3s)";
const INTERVAL = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;
async function fetchBytes(url, retries = 5) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + INTERVAL - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // Wayback が止まっているときは 200 で「Temporarily Offline」のページを返すことがある
      if (/Internet Archive: Temporarily Offline/.test(buf.toString("latin1"))) throw new Error("Wayback が一時停止中");
      return buf;
    } catch (err) {
      if (attempt >= retries) throw err;
      const backoff = 10000 * 2 ** attempt;
      console.warn(`  ! ${err.message}。${backoff / 1000}秒後に再試行 (${attempt + 1}/${retries})`);
      await sleep(backoff);
    }
  }
}

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}
async function writeAtomic(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(`${p}.part`, data);
  await rename(`${p}.part`, p);
}

// 版の一覧。中身（digest）が同じ版が続くところは1つにまとめ、最初と最後の日時を持つ
async function listSnapshots(page, url) {
  const cdx = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&fl=timestamp,original,statuscode,digest&filter=statuscode:200`;
  const text = (await fetchBytes(cdx)).toString("utf8");
  const runs = [];
  for (const line of text.trim().split("\n")) {
    const [timestamp, original, , digest] = line.split(" ");
    if (!/^\d{14}$/.test(timestamp ?? "")) continue;
    const last = runs.at(-1);
    if (last && last.digest === digest) last.until = timestamp;
    else runs.push({ page, timestamp, until: timestamp, digest, original });
  }
  // 次の版が出るまでは、その版が有効だったとみなす
  for (let i = 0; i < runs.length; i++) runs[i].next = runs[i + 1]?.timestamp ?? null;
  return runs.filter((r) => (r.next ?? "99999999") >= FIRST_NEEDED);
}

async function fetchExternal() {
  const index = [];
  for (const { page, url } of PAGES) {
    const runs = await listSnapshots(page, url);
    console.log(`[${page}] 版 ${runs.length} 件`);
    for (const r of runs) {
      const file = `${page}/${r.timestamp}.html`;
      const archive = `https://web.archive.org/web/${r.timestamp}/${r.original}`;
      const abs = path.join(EXT, file);
      if (!(await exists(abs))) {
        const buf = await fetchBytes(`http://web.archive.org/web/${r.timestamp}id_/${r.original}`);
        await writeAtomic(abs, buf);
        console.log(`  ${file} ${buf.length} バイト`);
      }
      index.push({ page, timestamp: r.timestamp, until: r.until, next: r.next, digest: r.digest, archive, file });
    }
  }
  // いまの版（市議会のサイトから直接）。取った日ごとに残し、前に取った分も目録に入れる
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
  if (!(await exists(path.join(EXT, "live", `${today}.html`)))) await writeAtomic(path.join(EXT, "live", `${today}.html`), await fetchBytes(LIVE));
  for (const f of (await readdir(path.join(EXT, "live"))).filter((f) => /^\d{8}\.html$/.test(f)).sort()) {
    const ts = `${f.slice(0, 8)}000000`;
    index.push({ page: "live", timestamp: ts, until: ts, next: null, digest: null, archive: LIVE, file: `live/${f}` });
  }
  await writeAtomic(path.join(EXT, "index.jsonl"), index.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\n完了: 版 ${index.length} 件 / 出力 data/external/meibo/`);
}

// ---------- 外部の資料を読む ----------
const WARDS = "中央|北|東|白石|厚別|豊平|清田|南|西|手稲";
const NAME_WARD = new RegExp(`^(.+?)[\\s　]*[（(](${WARDS})区[）)]$`);
const ymd = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

// 会派別名簿のページ1版 → [{ faction, count, members: [{ name, ward }] }]
// 会派の見出しは「○札幌市議会自由民主党議員会（25人）」、議員は1つのセルに「三上　洋右（豊平区）」
export function parseRosterPage(buf) {
  const head = buf.toString("latin1");
  const enc = /charset=["']?utf-8/i.test(head) ? "utf-8" : "shift_jis";
  const html = new TextDecoder(enc)
    .decode(buf)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // 文字飾りのタグはセルを分けないので外す（「（6</font><font size="-1">人）」。2007年8月）
    .replace(/<\/?(font|b|strong|a|span)\b[^>]*>/gi, "");
  const nodes = [];
  for (const raw of html.split(/<[^>]*>/)) {
    // セルの中の改行は詰める（「（6\n人）」）
    const s = toHalf(raw.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]*\r?\n[ \t]*/g, "")).trim();
    if (!s) continue;
    // 選出区が別のセルに分かれている版がある（2017年3月）。前のセルの氏名につなぐ
    if (new RegExp(`^[（(](${WARDS})区[）)]$`).test(s) && nodes.length) nodes[nodes.length - 1] += s;
    else nodes.push(s);
  }
  const factions = [];
  for (const t of nodes) {
    let m;
    if ((m = t.match(/^○?[\s　]*(.+?)[\s　]*（(\d+)[人名]）$/))) {
      factions.push({ raw: m[1], faction: formalFaction(m[1]), count: Number(m[2]), members: [] });
    } else if ((m = t.match(NAME_WARD)) && factions.length) {
      factions.at(-1).members.push({ name: normalizeName(m[1]), ward: `${m[2]}区` });
    }
  }
  return factions;
}
// 正式名は、名簿の見出しから先頭の「札幌市議会」を外したもの（「札幌市議会自由民主党議員会」→「自由民主党議員会」）
const formalFaction = (s) => s.replace(/[\s　]/g, "").replace(/^札幌市議会/, "");

// 名簿の版ごとの観測。中身が同じ版が続くときは、最初と最後に取得された日の両方で観測したとみなす
// （任期をまたぐときは、古い名簿が残っていただけなので最後の日は使わない）
async function readSnapshots() {
  const indexPath = path.join(EXT, "index.jsonl");
  if (!(await exists(indexPath))) throw new Error("外部の資料がない。先に --fetch を実行する");
  const index = (await readFile(indexPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const snaps = [];
  for (const r of index) {
    const buf = await readFile(path.join(EXT, r.file));
    const factions = parseRosterPage(buf);
    const taken = ymd(r.timestamp);
    const dates = [taken];
    if (r.until !== r.timestamp && termOf(ymd(r.until)) === termOf(taken)) dates.push(ymd(r.until));
    // 2015年ごろからのページには「更新日：2026年11月13日」がある。その日にはもうこの名簿だった
    const u = toHalf(new TextDecoder("utf-8").decode(buf)).match(/更新日：(\d{4})年(\d{1,2})月(\d{1,2})日/);
    const updated = u ? `${u[1]}-${u[2].padStart(2, "0")}-${u[3].padStart(2, "0")}` : null;
    if (updated && updated < taken && termOf(updated) === termOf(taken)) dates.unshift(updated);
    snaps.push({ ...r, updated, dates, factions });
  }
  return snaps;
}

// ---------- 会議録を読む ----------
// 本会議の出席議員・欠席議員の欄 → [{ file, date, term, names: [{ name, title }] , count, expected }]
// 欄の行は「　議　　　員　　　　　　　和　田　勝　也」。空白を除いて先頭の役職を外す
async function readRosters(meetings) {
  const out = [];
  for (const m of meetings) {
    if (m.kind === "委員会" || m.issue === "目次") continue;
    const lines = (await readFile(path.join(MD, m.file), "utf8")).split("\n").filter(Boolean);
    for (const [label, re] of [["出席", /^〇出席議員（(.+)）/], ["欠席", /^〇欠席議員（(.+)）/]]) {
      const k = lines.findIndex((l) => re.test(l));
      if (k < 0) continue;
      const n = toHalf(lines[k].match(re)[1]);
      const expected = n === "なし" ? 0 : Number(n.replace("人", ""));
      const names = [];
      for (let j = k + 1; j < lines.length; j++) {
        // 欄の終わりは区切り線か次の〇。見出しの直後に区切り線がある日もある（2011年5月19日）
        if (/^[〇―　]*[〇―]/.test(lines[j])) {
          if (names.length || /^〇/.test(lines[j])) break;
          continue;
        }
        // 新しい議長を選んだ日は、前の議長・副議長に「（前）」が付く（「副議長（前）　大嶋　薫」）
        const t = lines[j].replace(/[\s　]/g, "").match(/^(議長|副議長|臨時議長|仮議長|議員)(?:[（(]前[）)])?(.+)$/);
        if (t) names.push({ name: normalizeName(t[2]), title: t[1] });
      }
      out.push({ file: m.file, date: m.date, term: m.term, label, names, expected });
    }
  }
  return out;
}

// 会派を名乗っている箇所 → [{ date, term, name, raw, prev, source }]
//   発言: 議員の発言の最初の文の「私は、自由民主党議員会を代表し」（代表質問、討論、委員会の討論）
//   目次: 本会議の目次の「〇川田ただひさ議員（自由民主党）」（代表質問）。日付は目次の「第２号（２月20日）」
// 発言のほうは、次のものを除く
//   ・最初の文より後ろ（「質問に先立ちまして、…自由民主党議員会議員であります宗形雅俊議員の…」）
//   ・「（続）」で始まる発言。委員長報告が各会派の意見を引いている（「（続）次に、公明党を代表し、福田委員からは」）
//   ・直前の区切りも会派の名前のとき。共同提案（「自由民主党議員会、民主市民連合、公明党を代表し」）。prev で判断する
async function readMentions(meetings) {
  const out = [];
  const years = (await readdir(path.join(STRUCT, "speeches"))).filter((f) => /^\d{4}\.jsonl$/.test(f)).sort();
  for (const f of years) {
    for (const line of (await readFile(path.join(STRUCT, "speeches", f), "utf8")).split("\n")) {
      if (!line) continue;
      const s = JSON.parse(line);
      if (s.role !== "member" || !s.name) continue;
      const body = s.text.slice(s.head?.length ?? 0).replace(/^[\s　]+/, "");
      if (body.startsWith("（続）")) continue;
      const first = body.split(/。|\n/)[0];
      const m = first.match(/^(.*?)([^、「」（）]{2,40}?)を代表(?:し|して|いたし)/);
      if (!m) continue;
      const prev = m[1].replace(/、$/, "").split("、").pop();
      out.push({ date: s.date, term: termOf(s.date), name: s.name, raw: m[2], prev, via: "speech", source: `huid:${s.huid}` });
    }
  }
  for (const m of meetings) {
    if (m.kind === "委員会" || m.issue !== "目次") continue;
    const year = m.date.slice(0, 4);
    let date = m.date;
    for (const line of (await readFile(path.join(MD, m.file), "utf8")).split("\n")) {
      const h = toHalf(line).match(/^[\s　]*第\s*\d+\s*号（(\d+)月(\d+)日）/);
      if (h) date = `${year}-${h[1].padStart(2, "0")}-${h[2].padStart(2, "0")}`;
      const e = line.match(/^[\s　]*〇(.+?)議員（([^）]+)）/);
      if (e) out.push({ date, term: termOf(date), name: normalizeName(e[1]), raw: e[2], via: "toc", source: `toc:${m.file}` });
    }
  }
  // T2 の目次（toc.jsonl）の代表質問の会派も使う。上で読んだものと同じ日・氏名・会派なら1つにまとめる
  // （上の読み取りは無所属議員の代表質問なども拾い、T2 は行が折り返した項目も拾う）
  const tocPath = path.join(STRUCT, "toc.jsonl");
  if (await exists(tocPath)) {
    const have = new Set(out.filter((o) => o.via === "toc").map((o) => `${o.date}\t${o.name}\t${o.raw}`));
    for (const line of (await readFile(tocPath, "utf8")).trim().split("\n")) {
      const r = JSON.parse(line);
      for (const e of r.entries ?? []) {
        if (!e.faction || !e.name) continue;
        const name = normalizeName(e.name);
        if (have.has(`${r.date}\t${name}\t${e.faction}`)) continue;
        out.push({ date: r.date, term: termOf(r.date), name, raw: e.faction, via: "toc", source: `toc:${r.toc_file}` });
      }
    }
  }
  return out;
}

// 「〜を代表し」の前の部分から会派の呼び方を取り出す（「私は、日本共産党所属委員」→「日本共産党」）
const cleanMention = (s) =>
  s
    .replace(/[\s　]/g, "")
    .replace(/^(私は|わたしは|私|ただいまから)、?/, "")
    .replace(/^札幌市議会/, "")
    .replace(/(所属の?委員|所属の?議員|所属議員全員|に所属する委員)$/, "");

// ---------- CSV ----------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [header, ...body] = rows.filter((r) => r.some((c) => c !== ""));
  return body.map((r, i) => Object.fromEntries([...header.map((h, j) => [h, r[j] ?? ""]), ["_line", i + 2]]));
}
const csvCell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (header, rows) => [header.join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n";

async function readCsv(name) {
  const p = path.join(MEMBERS, name);
  return (await exists(p)) ? parseCsv(await readFile(p, "utf8")) : null;
}

// ---------- 任期と日付 ----------
const termStart = (term) => `${term.slice(0, 4)}-05-01`;
const termEnd = (term) => `${term.slice(5, 9)}-04-30`;
const dayBefore = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 会派の呼び方 → 正式名 ----------
// factions.csv の正式名と別名（略称・旧称）から引き、当てはまる正式名の一覧を返す。
// 同じ呼び方が任期によって別の会派を指すことがあるので、任期で絞る（「民主党・市民連合」は2011年からは「民主党・市民連合議員会」）。
// 絞っても2つ以上残ることがある（「日本維新の会」は、同じ任期の「日本維新の会」と「日本維新の会札幌議員会」の両方）
function factionResolver(factions) {
  const byKey = new Map();
  for (const f of factions ?? []) {
    const terms = f.terms ? f.terms.split(";") : null;
    for (const key of [f.faction, ...(f.aliases ? f.aliases.split(";") : [])]) {
      if (key) (byKey.get(key) ?? byKey.set(key, []).get(key)).push({ faction: f.faction, terms });
    }
  }
  return (raw, term) => {
    const cands = byKey.get(raw) ?? byKey.get(formalFaction(raw)) ?? [];
    return [...new Set(cands.filter((c) => !c.terms || c.terms.includes(term)).map((c) => c.faction))];
  };
}

// ---------- 根拠を集める ----------
export async function collect() {
  const readJsonl = async (p) => (await readFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const meetings = await readJsonl(path.join(STRUCT, "meetings.jsonl"));
  const speakers = await readJsonl(path.join(STRUCT, "speakers.jsonl"));
  const snaps = await readSnapshots();
  const rosters = await readRosters(meetings);
  const mentions = await readMentions(meetings);
  const factions = await readCsv("factions.csv");
  const aliases = await readCsv("aliases.csv");
  const members = await readCsv("members.csv");
  const alias = new Map((aliases ?? []).map((a) => [a.variant, a.name]));
  const canon = (name) => alias.get(name) ?? name;
  const resolve = factionResolver(factions);

  // 観測: 「この日、この議員はこの会派だった」。会議録の呼び方は、当てはまる正式名が2つ以上のこともある（factions）
  const obs = [];
  for (const s of snaps) {
    for (const f of s.factions) {
      for (const p of f.members) {
        for (const date of s.dates) {
          obs.push({ date, term: termOf(date), name: canon(p.name), faction: f.faction, factions: [f.faction], ward: p.ward, via: "snapshot", source: s.archive });
        }
      }
    }
  }
  const unresolved = [];
  const joint = [];
  for (const m of mentions) {
    const raw = cleanMention(m.raw);
    const hits = resolve(raw, m.term);
    if (!hits.length) unresolved.push({ ...m, raw });
    else if (m.via === "speech" && m.prev && resolve(cleanMention(m.prev), m.term).length) joint.push(m);
    else obs.push({ date: m.date, term: m.term, name: canon(m.name), faction: hits.length === 1 ? hits[0] : null, factions: hits, ward: null, via: m.via, raw, source: m.source });
  }
  obs.sort((a, b) => a.term.localeCompare(b.term) || a.name.localeCompare(b.name) || a.date.localeCompare(b.date) || a.via.localeCompare(b.via));

  // 在任: 任期×氏名ごとに、本会議の出席議員・欠席議員の欄と発言に出てきた日
  const seen = new Map();
  const see = (term, name, date) => {
    if (!term || !name) return;
    const key = `${term}\t${name}`;
    const a = seen.get(key) ?? seen.set(key, { term, name, first: date, last: date, roster: false }).get(key);
    if (date < a.first) a.first = date;
    if (date > a.last) a.last = date;
    return a;
  };
  for (const r of rosters) for (const n of r.names) see(r.term, canon(n.name), r.date).roster = true;
  for (const s of speakers) if (s.side === "member") see(s.term, canon(s.name), s.first), see(s.term, canon(s.name), s.last);
  // 任期ごとの、出席議員の欄がある最初と最後の日
  const rosterSpan = new Map();
  for (const r of rosters) {
    const a = rosterSpan.get(r.term) ?? rosterSpan.set(r.term, { first: r.date, last: r.date }).get(r.term);
    if (r.date < a.first) a.first = r.date;
    if (r.date > a.last) a.last = r.date;
  }

  return { meetings, speakers, snaps, rosters, mentions, factions, aliases, members, canon, resolve, obs, unresolved, joint, seen, rosterSpan };
}

// 在任の期間（下書き用）: 任期の最初の本会議から出ていれば任期の初日から、最後の本会議まで出ていれば任期の末日まで。
// そうでなければ、最初・最後に出てきた日（補欠選挙で入った、亡くなった・辞めたなど。実際の日はその前後のことがある）
function tenure(c, term, name) {
  const s = c.seen.get(`${term}\t${name}`);
  const span = c.rosterSpan.get(term);
  if (!s || !span) return { from: termStart(term), to: termEnd(term) };
  return { from: s.first <= span.first ? termStart(term) : s.first, to: s.last >= span.last ? termEnd(term) : s.last };
}

// ---------- 下書き ----------
// 任期×氏名ごとに観測を日付順に並べ、同じ会派が続くところを1行にする。会派が変わったところで行を分け、
// 新しい会派を最初に観測した日を from にする（実際に移った日はそれより前のことがある）。
// 当てはまる正式名が2つ以上ある観測（目次の略称など）では行を分けない
function draftMembers(c) {
  const people = new Map();
  const add = (term, name) => {
    const key = `${term}\t${name}`;
    return people.get(key) ?? people.set(key, { term, name, obs: [] }).get(key);
  };
  for (const s of c.seen.values()) add(s.term, s.name);
  for (const o of c.obs) if (o.term && o.name) add(o.term, o.name).obs.push(o);

  const rows = [];
  for (const p of [...people.values()].sort((a, b) => a.term.localeCompare(b.term) || a.name.localeCompare(b.name))) {
    const ward = mode(p.obs.filter((o) => o.ward).map((o) => o.ward)) ?? "";
    const { from, to } = tenure(c, p.term, p.name);
    const segs = [];
    const inside = p.obs.filter((o) => from <= o.date && o.date <= to); // 在任の外（辞めた後も名簿のページに残っていた、など）は使わない
    inside.forEach((o, i) => {
      const last = segs.at(-1);
      if (last && o.factions.includes(last.faction)) return last.obs.push(o);
      // 当てはまる正式名が2つ以上あるときは、後ろの観測で決まる会派に合わせる
      const faction = o.faction ?? inside.slice(i + 1).find((n) => n.faction && o.factions.includes(n.faction))?.faction;
      if (faction) segs.push({ faction, obs: [o] });
    });
    if (!segs.length) {
      rows.push({ term: p.term, name: p.name, faction: "", from, to, ward, source: "根拠なし" });
      continue;
    }
    segs.forEach((s, i) => {
      const snap = s.obs.find((o) => o.via === "snapshot");
      const minutes = s.obs.find((o) => o.via !== "snapshot");
      rows.push({
        term: p.term, name: p.name, faction: s.faction,
        from: i === 0 ? from : s.obs[0].date,
        to: i === segs.length - 1 ? to : dayBefore(segs[i + 1].obs[0].date),
        ward, source: [snap?.source, minutes?.source].filter(Boolean).join(" "),
      });
    });
  }
  return rows;
}
function mode(list) {
  const n = new Map();
  for (const v of list) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const MEMBER_COLUMNS = ["term", "name", "faction", "from", "to", "ward", "source"];

async function writeDraft(c) {
  const rows = draftMembers(c);
  await writeAtomic(path.join(STRUCT, "members_draft.csv"), toCsv(MEMBER_COLUMNS, rows));
  // 会派の一覧の下書き: 名簿に出てくる正式名と、出てくる任期
  const fx = new Map();
  for (const s of c.snaps) for (const f of s.factions) for (const d of s.dates) (fx.get(f.faction) ?? fx.set(f.faction, new Set()).get(f.faction)).add(termOf(d));
  const frows = [...fx].map(([faction, terms]) => ({ faction, aliases: "", terms: [...terms].sort().join(";") })).sort((a, b) => a.terms.localeCompare(b.terms) || a.faction.localeCompare(b.faction));
  await writeAtomic(path.join(STRUCT, "factions_draft.csv"), toCsv(["faction", "aliases", "terms"], frows));
  console.log(`下書き: data/struct/members_draft.csv ${rows.length} 行 / data/struct/factions_draft.csv ${frows.length} 行`);
  console.log(`根拠のない議員: ${rows.filter((r) => !r.faction).length} 人・任期`);
  for (const r of rows.filter((r) => !r.faction)) console.log(`  ${r.term} ${r.name}`);
  printUnresolved(c);
}

// 会派の呼び方として読めなかったもの（factions.csv の別名に足す候補）。議案の付託などの動議は除いて数える
function printUnresolved(c, limit = 15) {
  const un = new Map();
  for (const u of c.unresolved) {
    if (/設定|付託|指名|推薦|推選|動議|選任|議案|日間|\d+人$|件/.test(u.raw)) continue;
    un.set(u.raw, (un.get(u.raw) ?? 0) + 1);
  }
  console.log(`会派の呼び方として読めなかったもの: ${[...un.values()].reduce((a, b) => a + b, 0)} 件（${un.size} 種類。多い順に${limit}種類）`);
  for (const [raw, n] of [...un].sort((a, b) => b[1] - a[1]).slice(0, limit)) console.log(`  ${n}  ${raw}`);
}

// ---------- 検証 ----------
function verify(c) {
  if (!c.members || !c.factions || !c.aliases) throw new Error("pipeline/members/ の members.csv・factions.csv・aliases.csv がそろっていない");
  const report = new Map();
  const push = (label, line) => (report.get(label) ?? report.set(label, []).get(label)).push(line);
  const fail = new Set();
  const check = (label, isFailure = true) => {
    report.set(label, report.get(label) ?? []);
    if (isFailure) fail.add(label);
    return (line) => push(label, line);
  };

  // 1. CSV の形
  const badRow = check("members.csv: 項目が欠けている・形が違う");
  const badFaction = check("members.csv: 会派が factions.csv にない");
  const overlap = check("members.csv: 同じ任期・氏名で期間が重なる、または切れ目がある");
  const badAlias = check("aliases.csv: 別の表記が members.csv の氏名になっている、または寄せ先がない");
  const badFx = check("factions.csv: 任期の形が違う、または正式名が重なる");
  const known = new Set(c.factions.map((f) => f.faction));
  const fxSeen = new Set();
  for (const f of c.factions) {
    if (fxSeen.has(f.faction) || !f.terms || f.terms.split(";").some((t) => !/^\d{4}-\d{4}$/.test(t))) badFx(`${f._line}行: ${f.faction}`);
    fxSeen.add(f.faction);
  }
  // lineage（名前だけ変えた会派の系列。工程7で1つの会派にまとめる）は、正式名のどれかで、その行自身も同じ系列に入っていること
  const badLineage = check("factions.csv: lineage が正式名にない、または系列の名前の行がその系列にない");
  for (const f of c.factions) if (f.lineage && (!known.has(f.lineage) || (c.factions.find((g) => g.faction === f.lineage)?.lineage ?? "") !== f.lineage)) badLineage(`${f._line}行: ${f.faction} → ${f.lineage}`);
  const rowsBy = new Map();
  for (const r of c.members) {
    const missing = ["term", "name", "faction", "from", "to", "source"].filter((k) => !r[k]);
    if (missing.length || !/^\d{4}-\d{4}$/.test(r.term) || !DATE.test(r.from) || !DATE.test(r.to) || r.from > r.to || r.from < termStart(r.term) || r.to > termEnd(r.term)) {
      badRow(`${r._line}行: ${[r.term, r.name, r.faction, r.from, r.to].join(",")}${missing.length ? `（${missing.join("・")}がない）` : ""}`);
      continue;
    }
    if (!known.has(r.faction)) badFaction(`${r._line}行: ${r.term} ${r.name} ${r.faction}`);
    const key = `${r.term}\t${r.name}`;
    (rowsBy.get(key) ?? rowsBy.set(key, []).get(key)).push(r);
  }
  for (const rows of rowsBy.values()) {
    rows.sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].from !== nextDay(rows[i - 1].to)) overlap(`${rows[i - 1]._line}行と${rows[i]._line}行: ${rows[i].term} ${rows[i].name} ${rows[i - 1].to} → ${rows[i].from}`);
    }
  }
  const memberNames = new Set(c.members.map((r) => r.name));
  for (const a of c.aliases) if (memberNames.has(a.variant) || !memberNames.has(a.name)) badAlias(`${a._line}行: ${a.variant} → ${a.name}`);

  const factionAt = (term, name, date) => (rowsBy.get(`${term}\t${name}`) ?? []).find((r) => r.from <= date && date <= r.to)?.faction ?? null;
  const span = (term, name) => {
    const rows = rowsBy.get(`${term}\t${name}`);
    return rows ? { from: rows[0].from, to: rows.at(-1).to } : null;
  };

  // 2. 議員全員に会派がある
  const noSpeaker = check("会派がない: 発言者の一覧（speakers.jsonl）の議員");
  const noRoster = check("会派がない: 本会議の出席議員・欠席議員の欄の議員");
  for (const s of c.speakers) {
    if (s.side !== "member") continue;
    const name = c.canon(s.name);
    for (const d of new Set([s.first, s.last])) if (!factionAt(s.term, name, d)) noSpeaker(`${s.term} ${s.name}${name !== s.name ? `（→${name}）` : ""} ${d}（発言 ${s.count} 件）`);
  }
  const rosterMiss = new Map();
  for (const r of c.rosters) {
    for (const n of r.names) {
      const name = c.canon(n.name);
      if (!factionAt(r.term, name, r.date)) {
        const key = `${r.term} ${name}`;
        const a = rosterMiss.get(key) ?? rosterMiss.set(key, { n: 0, first: r.file }).get(key);
        a.n++;
      }
    }
  }
  for (const [key, a] of rosterMiss) noRoster(`${key}（${a.n} 日分。最初は ${a.first}）`);

  // 3. 根拠と食い違わない
  const vsSnap = check("外部の名簿（会派別名簿）と食い違う");
  const vsMinutes = check("会議録（目次の会派、発言の「〜を代表し」）と食い違う");
  const outside = check("在任の期間の外で名簿のページに載っている（辞めた後もページに残っていた、など。確認用）", false);
  for (const o of c.obs) {
    const s = span(o.term, o.name);
    if (s && (o.date < s.from || o.date > s.to)) {
      if (o.via === "snapshot") outside(`${o.term} ${o.name} ${o.date} ${o.faction}（members.csv は ${s.from}〜${s.to}）`);
      else vsMinutes(`${o.term} ${o.name} ${o.date} ${o.raw}: 在任の期間（${s.from}〜${s.to}）の外 ${o.source}`);
      continue;
    }
    const f = factionAt(o.term, o.name, o.date);
    if (f && o.factions.includes(f)) continue;
    const line = `${o.term} ${o.name} ${o.date}: members.csv は ${f ?? "なし"}、${o.via === "snapshot" ? o.faction : `「${o.raw}」`} ${o.via === "snapshot" ? o.source.replace(/^https:\/\/web\.archive\.org\/web\/(\d+)\/.*/, "wayback:$1") : o.source}`;
    (o.via === "snapshot" ? vsSnap : vsMinutes)(line);
  }

  // 4. 確認用（失敗にはしない）
  const counts = check("出席議員の欄の人数が見出しと合わない（原本の誤り。空行や議長の重複など。確認用）", false);
  for (const r of c.rosters) if (new Set(r.names.map((n) => n.name)).size !== r.expected) counts(`${r.file} ${r.label} 見出し ${r.expected} 人 / 読めた ${new Set(r.names.map((n) => n.name)).size} 人`);
  const stale = check("members.csv にあるが、その任期の会議録にも外部の名簿にも出てこない（確認用）", false);
  const appears = new Set([...c.seen.keys(), ...c.obs.map((o) => `${o.term}\t${o.name}`)]);
  for (const key of rowsBy.keys()) if (!appears.has(key)) stale(key.replace("\t", " "));

  // 集計
  const terms = [...new Set(c.members.map((r) => r.term))].sort();
  console.log(`名簿: ${c.members.length} 行 / 会派 ${c.factions.length} / 別名 ${c.aliases.length}`);
  for (const t of terms) {
    const names = new Set(c.members.filter((r) => r.term === t).map((r) => r.name));
    const moved = [...names].filter((n) => new Set(rowsBy.get(`${t}\t${n}`).map((r) => r.faction)).size > 1).length;
    const fx = new Set(c.members.filter((r) => r.term === t).map((r) => r.faction));
    console.log(`  ${t}: 議員 ${names.size} 人（任期中に会派が変わった ${moved} 人）/ 会派 ${fx.size}`);
  }
  console.log(`根拠: 外部の名簿の版 ${c.snaps.length} / 出席議員の欄 ${c.rosters.length} / 会派を名乗った箇所 ${c.obs.filter((o) => o.via !== "snapshot").length}（共同提案として除いた ${c.joint.length}）`);
  printUnresolved(c, 10);
  console.log("");
  for (const [label, list] of report) {
    console.log(`${label}: ${list.length} 件`);
    for (const l of list.slice(0, 20)) console.log(`  ${l}`);
    if (list.length > 20) console.log(`  ほか ${list.length - 20} 件`);
  }
  if ([...fail].some((l) => report.get(l).length)) process.exitCode = 1;
}
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);

// ---------- 本体 ----------
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--fetch")) return fetchExternal();
  const c = await collect();
  // 観測の一覧（確認用）。どの日にどの根拠でどの会派だったか
  await writeAtomic(path.join(STRUCT, "member_evidence.jsonl"), c.obs.map((o) => JSON.stringify(o)).join("\n") + "\n");
  if (args.includes("--draft")) return writeDraft(c);
  return verify(c);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  });
}
