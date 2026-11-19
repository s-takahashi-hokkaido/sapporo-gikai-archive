// 工程3以降のスクリプトで共有する小さな関数。
// 設計: docs/工程3の設計.md の「共通の約束」
// 変えるときは、これを使うほかのスクリプトの結果が変わらないことを確かめる。

import { readFile } from "node:fs/promises";

// 統一地方選の年。任期はこの年の5月1日から4年
// （選挙の年は4月に会議がなく、5月の臨時会から新しい任期になる。2007〜2023年で確認）
const ELECTIONS = [2003, 2007, 2011, 2015, 2019, 2023, 2027];

// 任期: "2024-02-20" → "2023-2027"
export function termOf(date) {
  if (!date) return null;
  let start = null;
  for (const y of ELECTIONS) if (date >= `${y}-05-01`) start = y;
  return start === null ? null : `${start}-${start + 4}`;
}

// 全角数字を半角に
export const toHalfDigits = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 氏名: 全角・半角の空白を除き、末尾の「議員」「委員」を外す（"林　清治委員" → "林清治"）
export function normalizeName(s) {
  if (s == null) return null;
  return s.replace(/[\s　]/g, "").replace(/(議員|委員)$/, "");
}

// 会期: ("令和 ６年第 １回定例会", "2024-02-20") → "2024-1定"。定例会・臨時会でなければ null
export function sessionOf(meeting, date) {
  const m = toHalfDigits(meeting ?? "").match(/第\s*(\d+)\s*回\s*(定例会|臨時会)/);
  if (!m || !date) return null;
  return `${date.slice(0, 4)}-${Number(m[1])}${m[2] === "定例会" ? "定" : "臨"}`;
}

// 委員会名: 年号の前置きを外し、種類を付ける
// "平成１９年（常任）建設委員会" → { committee: "建設委員会", committeeType: "常任" }
export function committeeOf(meeting) {
  if (!meeting) return { committee: null, committeeType: null };
  let name = meeting.replace(/^[\s　]*(平成|令和)[\s　]*(元|[０-９\d]+)[\s　]*年/, "");
  let committeeType;
  if (name.startsWith("（常任）")) {
    name = name.slice("（常任）".length);
    committeeType = "常任";
  } else if (/予算特別委員会/.test(name)) committeeType = "予算特別";
  else if (/決算特別委員会/.test(name)) committeeType = "決算特別";
  else if (/議案審査特別委員会/.test(name)) committeeType = "議案審査特別";
  else if (/調査特別委員会/.test(name)) committeeType = "調査特別";
  else if (/議会運営委員会/.test(name)) committeeType = "議会運営";
  else committeeType = "その他";
  // 「議会運営委員会第１回（１臨）」の回数と会期は名前から外す
  if (committeeType === "議会運営") name = name.replace(/第[０-９\d]+回.*$/, "");
  return { committee: name, committeeType };
}

// 発言単位の閲覧URL: 会議の閲覧URLから UNID を外し、HUID を足す。
// 閲覧画面がその発言の位置で開く（2026年11月15日に確認。本文のフレームが #HUID<番号> に飛ぶ）
export function speechUrl(viewer, huid) {
  if (!viewer || !huid) return null;
  return viewer.replace(/&UNID=[^&]*/, "").replace("&KGNO=", `&HUID=${huid}&KGNO=`);
}

// data/md のファイルを読み、前付け（meta）と本文（見出しの後ろ）に分ける
export async function readMd(mdPath) {
  const md = await readFile(mdPath, "utf8");
  const fm = md.match(/^---\n([\s\S]*?)\n---\n\n# [^\n]*\n/);
  if (!fm) throw new Error(`前付けがない: ${mdPath}`);
  const meta = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^(\w+): (.*)$/);
    if (m) meta[m[1]] = JSON.parse(m[2]);
  }
  return { meta, body: md.slice(fm[0].length) };
}

// CSV（pipeline/members/*.csv）を読む。1行目が見出し。セルの中の改行はない前提
export function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") cells.push(cur), (cur = "");
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

// 会派の名簿（T3 の pipeline/members/）を読み、引く関数を返す。
// canon(氏名): aliases.csv で表記ゆれを寄せる。factionOf(任期, 氏名, 日付): from ≦ 日付 ≦ to の行の会派（正式名）。名簿がなければ factionOf は null
// 引き方は設計書の「会派の名簿」のとおり。T4（03d_plenary.mjs）と T5（03e_committee.mjs）が使う
export async function loadMembers(membersDir) {
  const read = (name) => readFile(`${membersDir}/${name}`, "utf8").catch(() => null);
  const aliases = new Map();
  const at = await read("aliases.csv");
  if (at) for (const a of parseCsv(at)) aliases.set(normalizeName(a.variant), normalizeName(a.name));
  const canon = (name) => (name == null ? name : aliases.get(name) ?? name);
  const mt = await read("members.csv");
  if (!mt) return { canon, factionOf: null };
  const byKey = new Map();
  for (const m of parseCsv(mt)) {
    const key = `${m.term}\t${normalizeName(m.name)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  const factionOf = (term, name, date) => (byKey.get(`${term}\t${canon(name)}`) ?? []).find((m) => m.from <= date && date <= m.to)?.faction || null;
  return { canon, factionOf };
}

// 名前だけ変えた会派の系列（factions.csv の lineage 列。値は系列のいまの名前）。工程7で、古い名前のころの主張も1つの会派にまとめるのに使う。
// 返すもの:
//   lineageOf(呼び方): 正式名・別名から系列の名前を返す。括弧の書き添え（「民主市民連合議員会（旧…）」）は外して引く。系列のない会派と知らない呼び方は null
//   chains: 名前が2つ以上ある系列ごとの名前の移り変わり [{ lineage, steps: [{ faction, from, to }] }]。since より前は数えない
// 移り変わりは members.csv の期間から作る。日ごとに、その系列でいちばん多くの議員が入っている名前を取る（1人だけ先に移った、などで揺れないように）
export async function loadLineages(membersDir, since = "2007-05-01") {
  const factions = parseCsv(await readFile(`${membersDir}/factions.csv`, "utf8"));
  const members = parseCsv(await readFile(`${membersDir}/members.csv`, "utf8"));
  const byKey = new Map();
  for (const f of factions) if (f.lineage) for (const k of [...(f.aliases ? f.aliases.split(";") : []), f.faction]) if (k) byKey.set(k, f.lineage); // 正式名を後に置いて、別名より優先する
  const lineageOf = (raw) => byKey.get(String(raw ?? "").replace(/[（(].*$/, "").trim()) ?? null;
  const chains = [];
  for (const lineage of new Set(factions.map((f) => f.lineage).filter(Boolean))) {
    const names = new Set(factions.filter((f) => f.lineage === lineage).map((f) => f.faction));
    const rows = members.filter((m) => names.has(m.faction) && m.to >= since);
    const days = [...new Set([since, ...rows.map((m) => m.from).filter((d) => d > since)])].sort();
    const steps = [];
    for (const d of days) {
      const n = new Map();
      for (const m of rows) if (m.from <= d && d <= m.to) n.set(m.faction, (n.get(m.faction) ?? 0) + 1);
      const top = [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!top || steps.at(-1)?.faction === top) continue;
      if (steps.length) steps.at(-1).to = new Date(Date.parse(`${d}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
      steps.push({ faction: top, from: d, to: null });
    }
    if (!steps.length) continue;
    steps.at(-1).to = rows.reduce((a, m) => (m.to > a ? m.to : a), "");
    if (new Set(steps.map((s) => s.faction)).size >= 2) chains.push({ lineage, steps });
  }
  return { lineageOf, chains };
}
