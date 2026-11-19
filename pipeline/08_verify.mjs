#!/usr/bin/env node
// 工程8: 数字と引用を照合する（AI は使わない）。候補者が人前で口にする前に通す。
// 作り方: docs/照合と手直し.md
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/08_verify.mjs      # 照合して、topics/要確認.md と verify/ に書く（1分ほど）
//
// 会議録の原文（data/struct/、Git の外）が要る。クローンしたばかりで data/ がなければ、工程1〜3をすべての年について先に流す（docs/動かし方.md）
//
// 照合は2段:
// 1. 工程5の記録 ↔ 会議録の原文（data/struct/speeches/）
//    - 数字（numbers.value）が、その発言（huid）の原文にあるか（数字の全角・半角とカンマの有無はそろえて比べる）
//    - 約束（commitments.quote）が、その発言の原文にそのままあるか（空白と改行は無視する）
//    - その発言になくても、同じまとまり（工程3）の別の発言にあれば「別の発言」（出典の発言番号の付け間違いで、中身は原文どおり）。どこにもなければ「原文にない」（言い換え・縮めなど）
// 2. 工程6・7のまとめ（bundles/<話題>/<任期>.json、topics/<話題>/history.json）↔ 引いた記録
//    - 文中の「」が、その文で引いた記録の約束にあるか。あっても、その約束が 1 で「原文にない」なら要確認
//    - 文中の数字が、その文で引いた記録（見出し・要旨・数字・約束・日付）にあるか。月・日、「3年」のような短い期間は見ない
//    - 出典の番号がない文
//    - 拾わないもの（事実の数字ではない）: 任期の区切りの年（「2019年以降は」「2007〜2011年は」で、引いた記録にその時期のものがあるとき）、
//      「2019年以降のまとめには出てこない」の年、「2〜3月」の2のような月の幅、「会議録は2026年6月ごろの分まで」の注記
//    - 20年のまとめの「市の答弁の変化」で、項目の1文目が出典のない書き出しの文でも、続く文がすべて出典付きで、続く文にない数字や「」がなければ要確認にしない
//      （続く文のまとめ。README の頭にそう書いてある）。2026年11月18日に細かく分けた5分野の要確認を人が確かめて決めた（docs/照合と手直し.md）
// 出力: topics/要確認.md（人が見る一覧。話題ごと、会議録へのリンク付き）、verify/records.jsonl（1 の食い違い）、verify/summaries.jsonl（2 の要確認）
//       verify/ は Git に入れる。06・07 の --render が summaries.jsonl を読んで印を付けるので、data/ のないクローンでも印が消えない
// 数は機械的な目安で、要確認がすべて誤りとは限らない（「第6波」の6を拾う、など）。リンク先の原文で確かめる

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toHalfDigits } from "./lib.mjs";
import { loadRecords, marksOf, sentences } from "./06_bundle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const squash = (s) => (s ?? "").replace(/[\s　]/g, "");
const norm = (s) => toHalfDigits(squash(s)).replace(/[，,]/g, "").replace(/．/g, ".").replace(/％/g, "%");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function main() {
  const records = await loadRecords();
  const recById = new Map(records.map((r) => [r.id, r]));

  // 1. 記録 ↔ 原文
  const years = [...new Set(records.map((r) => r.date.slice(0, 4)))];
  const noOrig = years.filter((y) => !existsSync(path.join(ROOT, "data", "struct", "speeches", `${y}.jsonl`)));
  if (noOrig.length) {
    // 原文がないと、すべての数字と引用が「原文にない」になり、印が付きすぎる
    console.error(`会議録の原文（data/struct/speeches/）がない年: ${noOrig.join("、")}。照合には原文が要る。docs/動かし方.md の工程1〜3を、すべての年について先に流す`);
    process.exit(1);
  }
  const speech = new Map();
  for (const y of years) {
    const p = path.join(ROOT, "data", "struct", "speeches", `${y}.jsonl`);
    if (existsSync(p)) for (const s of await readJsonl(p)) speech.set(s.huid, norm(s.text)); // 数字の全角・半角とカンマはそろえて比べる（記録の数字は半角に直されていることがある）
  }
  // 記録のもとになったまとまり（工程3）の発言の並び。記録の発言になくても、同じまとまりの別の発言にあれば原文どおり
  const exHuids = new Map();
  for (const y of years)
    for (const k of ["k1", "k2", "k3"]) {
      const p = path.join(ROOT, "data", "struct", "exchanges", `${y}-${k}.jsonl`);
      if (existsSync(p)) for (const e of await readJsonl(p)) exHuids.set(e.id, e.huids);
    }
  const recIssues = [];
  const badQuote = new Set(); // `${id}\t${quote}` で、原文にない約束
  let nNum = 0, nQuote = 0;
  for (const r of records) {
    const inOwn = (h, v) => speech.get(h)?.includes(v);
    const inAny = (v) => (exHuids.get(r.exchange) ?? r.huids).some((h) => speech.get(h)?.includes(v));
    for (const n of r.numbers) {
      nNum++;
      const v = norm(n.value);
      if (inOwn(n.huid, v)) continue;
      recIssues.push({ id: r.id, kind: "数字", value: n.value, meaning: n.meaning, huid: n.huid, reason: inAny(v) ? "別の発言" : "原文にない" });
    }
    for (const c of r.commitments) {
      nQuote++;
      const v = norm(c.quote).replace(/。$/, "");
      if (inOwn(c.huid, v)) continue;
      const reason = inAny(v) ? "別の発言" : "原文にない";
      recIssues.push({ id: r.id, kind: "引用", value: c.quote, speaker: c.speaker, huid: c.huid, reason });
      if (reason === "原文にない") badQuote.add(`${r.id}\t${norm(c.quote)}`);
    }
  }
  const badNumRec = new Set(recIssues.filter((x) => x.kind === "数字" && x.reason === "原文にない").map((x) => `${x.id}\t${norm(x.value)}`));

  // 2. まとめ ↔ 引いた記録
  const hay = (r) => norm([r.title, r.question, r.answer, r.date, r.committee, ...r.places, ...r.numbers.flatMap((n) => [n.value, n.meaning]), ...r.commitments.map((c) => c.quote)].join("｜"));
  const sumIssues = [];
  let nSent = 0, nLead = 0;
  const TB = "(2003|2007|2011|2015|2019|2023|2027)"; // 任期の区切りの年
  const hasNum = (s, d) => new RegExp(`(?<!\\d)${esc(d)}(?!\\d)`).test(s);
  // lead: 1文目が書き出しの文でもよい欄（20年のまとめの「市の答弁の変化」）
  function checkText(where, text, { lead = false } = {}) {
    const ss = sentences(text);
    ss.forEach((s, i) => {
      nSent++;
      const ids = marksOf(s);
      const body = s.replace(/\[[^\]]*\]/g, "");
      if (!ids.length) {
        const rest = ss.slice(i + 1);
        const restBody = norm(rest.join("").replace(/\[[^\]]*\]/g, ""));
        const isLead =
          lead && i === 0 && rest.length && rest.every((x) => marksOf(x).length) &&
          [...norm(body).matchAll(/\d+(?:\.\d+)?/g)].every((m) => hasNum(restBody, m[0])) &&
          [...body.matchAll(/「([^」]+)」/g)].every((m) => restBody.includes(norm(m[1])));
        if (isLead) nLead++;
        else sumIssues.push({ ...where, reason: "出典のない文", sentence: body });
        return;
      }
      const recs = ids.map((id) => recById.get(id)).filter(Boolean);
      if (recs.length < ids.length) sumIssues.push({ ...where, reason: "記録にない番号", sentence: body, ids });
      // 引いた記録のまとまり（1人分の質問と答弁）の会議録の原文。記録の要旨や引用になくても、原文にあれば確かめられたものとする
      // （記録の引用が原文と少し違い、まとめのほうが原文どおりに直してある、など。2026年11月18日の人の確かめで見つかった）
      let orig = null;
      const inOrig = (v) => (orig ??= recs.flatMap((r) => (exHuids.get(r.exchange) ?? r.huids).map((x) => speech.get(x) ?? "")).join("｜")).includes(v);
      const quoteInOrig = (qq) => qq.split(/（略）|\(略\)|…/).filter(Boolean).every(inOrig); // 「（略）」で間を省いた引用は、前後をそれぞれ探す
      for (const q of body.matchAll(/「([^」]+)」/g)) {
        const qq = norm(q[1]).replace(/。$/, "");
        const hit = recs.flatMap((r) => r.commitments.filter((c) => norm(c.quote).includes(qq)).map((c) => ({ r, c })));
        if (!hit.length) {
          if (!recs.some((r) => hay(r).includes(qq)) && !quoteInOrig(qq)) sumIssues.push({ ...where, reason: "引用が引いた記録にない", value: q[1], sentence: body, ids });
        } else if (hit.every(({ r, c }) => badQuote.has(`${r.id}\t${norm(c.quote)}`)) && !quoteInOrig(qq)) sumIssues.push({ ...where, reason: "引用が会議録の原文と合わない", value: q[1], sentence: body, ids });
      }
      // 任期の区切りを表す言い回し（「2019年5月以降のまとめには出てこない」「2015〜2019年の任期」）の年は、事実の数字ではないので見ない
      // 「2007〜2011年は」「2019年以降は」も、引いた記録にその時期のものがあれば任期の区切りとして見ない。会議録の範囲の注記も外す
      const recYears = recs.map((r) => Number(r.date.slice(0, 4)));
      const nb = norm(body)
        .replace(/(2003|2007|2011|2015|2019|2023|2027)年5月(以降|〜(2007|2011|2015|2019|2023|2027)年4月)/g, "")
        .replace(/(2003|2007|2011|2015|2019|2023)〜(2007|2011|2015|2019|2023|2027)年(の|まで|に|は)?任期/g, "")
        .replace(new RegExp(`${TB}年(?:5月)?(?:からの任期)?以降(?:の任期)?の(?:まとめ|記録)`, "g"), "")
        .replace(/会議録は\d{4}年\d{1,2}月ごろの分まで/g, "")
        .replace(new RegExp(`${TB}〜${TB}年`, "g"), (m, a, b) => (recYears.some((y) => y >= Number(a) && y <= Number(b)) ? "" : m))
        .replace(new RegExp(`${TB}年以降(?=は|も|、|の任期)`, "g"), (m, a) => (recs.some((r) => Number(r.term.slice(0, 4)) >= Number(a)) ? "" : m));
      const h = recs.map(hay).join("｜");
      for (const x of nb.matchAll(/\d+(?:\.\d+)?/g)) {
        const after = nb.slice(x.index + x[0].length, x.index + x[0].length + 2);
        const before = nb.slice(Math.max(0, x.index - 2), x.index);
        if (/^[月日時]/.test(after) || (/^(年|年度)/.test(after) && x[0].length <= 2 && !/(平成|令和|昭和)$/.test(before))) continue;
        if (/^[〜~]\d{1,2}月/.test(nb.slice(x.index + x[0].length)) && x[0].length <= 2) continue; // 「2〜3月」の2
        const isYear = /^(19[89]\d|20[0-3]\d)$/.test(x[0]) && /^(年|〜|~|-|－)/.test(after);
        const numRe = new RegExp(`(?<![\\d.])${esc(x[0])}(?![\\d])`);
        // 1桁の数字は原文のどこかに出やすいので、原文で確かめるのは2桁以上だけ
        const numInOrig = () => !isYear && x[0].replace(".", "").length >= 2 && (inOrig(x[0]), numRe.test(orig));
        const found = isYear ? recs.some((r) => Math.abs(Number(r.date.slice(0, 4)) - Number(x[0])) <= 1) || h.includes(x[0]) : numRe.test(h) || numInOrig();
        if (!found) sumIssues.push({ ...where, reason: "数字が引いた記録にない", value: x[0], sentence: body, ids });
        else if (!isYear && recs.every((r) => r.numbers.some((n) => badNumRec.has(`${r.id}\t${norm(n.value)}`) && norm(n.value).includes(x[0])) && !hay({ ...r, numbers: [] }).includes(x[0])) && !numInOrig())
          sumIssues.push({ ...where, reason: "数字が会議録の原文と合わない", value: x[0], sentence: body, ids });
      }
    });
  }
  const files = [];
  const bdir = path.join(ROOT, "bundles");
  if (existsSync(bdir))
    for (const t of await readdir(bdir, { withFileTypes: true }))
      if (t.isDirectory()) for (const f of (await readdir(path.join(bdir, t.name))).filter((f) => /^\d{4}-\d{4}\.json$/.test(f))) files.push({ topic: t.name, doc: `任期 ${f.slice(0, 9)}`, file: path.join(bdir, t.name, f), kind: "bundle" });
  const tdir = path.join(ROOT, "topics");
  if (existsSync(tdir))
    for (const t of await readdir(tdir, { withFileTypes: true })) if (t.isDirectory() && existsSync(path.join(tdir, t.name, "history.json"))) files.push({ topic: t.name, doc: "20年のまとめ（README）", file: path.join(tdir, t.name, "history.json"), kind: "history" });
  for (const f of files) {
    const o = JSON.parse(await readFile(f.file, "utf8")).output;
    const fields =
      f.kind === "bundle"
        ? [["要点", o.summary], ...o.developments.map((d) => [`主な動き「${d.heading}」`, d.text]), ...o.factions.map((x) => [`会派「${x.faction}」`, x.text]), ...o.city_stance.map((s) => ["市の答弁の変化", s]), ...o.open_issues.map((s) => ["残っている論点", s])]
        : [["現状", o.current], ...o.history.map((d) => [`20年の経緯「${d.heading}」`, d.text]), ...o.factions.map((x) => [`会派「${x.faction}」`, x.text]), ...o.city_stance.map((s) => ["市の答弁の変化", s]), ...o.open_issues.map((s) => ["未解決の論点", s])];
    for (const [section, text] of fields) checkText({ topic: f.topic, doc: f.doc, section }, text, { lead: f.kind === "history" && section === "市の答弁の変化" });
  }

  await mkdir(path.join(ROOT, "verify"), { recursive: true });
  await writeFile(path.join(ROOT, "verify", "records.jsonl"), recIssues.map((x) => JSON.stringify(x)).join("\n") + "\n");
  await writeFile(path.join(ROOT, "verify", "summaries.jsonl"), sumIssues.map((x) => JSON.stringify(x)).join("\n") + "\n");

  // 人が見る一覧。重いもの（原文と合わない、記録にない番号、引用が引いた記録にない）を先に
  const weight = { "引用が会議録の原文と合わない": 0, "数字が会議録の原文と合わない": 1, "記録にない番号": 2, "引用が引いた記録にない": 3, "数字が引いた記録にない": 4, "出典のない文": 5 };
  const link = (id) => {
    const r = recById.get(id);
    return r ? `[${r.date}](${r.url})` : id;
  };
  const cnt = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  const rc = cnt(recIssues, (x) => `${x.kind}: ${x.reason}`);
  const sc = cnt(sumIssues, (x) => x.reason);
  const lines = [
    "# 要確認の一覧（工程8）",
    "",
    `${new Date().toLocaleString("ja-JP")} に \`pipeline/08_verify.mjs\` で作った。まとめ（任期ごと・20年）の文のうち、数字や「」の引用を、引いた記録や会議録の原文で確かめられなかったもの。人前で使う前に、リンク先の原文で確かめる。機械的な照合なので、要確認がすべて誤りとは限らない。`,
    "",
    "## 数",
    "",
    `- 工程5の記録 ↔ 会議録の原文: 数字 ${nNum}個、引用 ${nQuote}個のうち、${Object.entries(rc).map(([k, v]) => `${k} ${v}`).join("、") || "食い違いなし"}`,
    `- まとめ ↔ 引いた記録: ${files.length}ファイル・${nSent}文のうち、${Object.entries(sc).sort((a, b) => weight[a[0]] - weight[b[0]]).map(([k, v]) => `${k} ${v}`).join("、") || "要確認なし"}。20年のまとめの「市の答弁の変化」の書き出しの文 ${nLead}文は、続く出典付きの文のまとめなので要確認にしていない`,
    "",
    "「別の発言」は、記録の数字や引用が、記録の付けた発言番号ではなく同じまとまり（1人分の質問と答弁）の別の発言にあったもの（中身は原文どおり）。「原文にない」は、言い換えや縮めで原文そのままでないもの。",
  ];
  const byTopic = new Map();
  for (const x of sumIssues) {
    if (!byTopic.has(x.topic)) byTopic.set(x.topic, []);
    byTopic.get(x.topic).push(x);
  }
  for (const [topic, xs] of [...byTopic].sort()) {
    xs.sort((a, b) => weight[a.reason] - weight[b.reason] || a.doc.localeCompare(b.doc));
    lines.push("", `## ${topic}（${xs.length}件）`, "");
    for (const x of xs) lines.push(`- **${x.reason}**${x.value ? `「${x.value.slice(0, 60)}」` : ""}（${x.doc}・${x.section}）: ${x.sentence.trim().slice(0, 120)}${x.ids ? ` — 出典 ${x.ids.map(link).join("、")}` : ""}`);
  }
  await writeFile(path.join(ROOT, "topics", "要確認.md"), lines.join("\n") + "\n");
  console.log(`記録 ↔ 原文: 数字 ${nNum}、引用 ${nQuote} → ${JSON.stringify(rc)}`);
  console.log(`まとめ ↔ 記録: ${files.length}ファイル、${nSent}文 → ${JSON.stringify(sc)}（書き出しの文として外した ${nLead}文）`);
  console.log("→ topics/要確認.md、verify/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
