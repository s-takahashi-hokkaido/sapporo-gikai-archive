#!/usr/bin/env node
// 工程3 T5: 委員会の発言（data/struct/speeches）を、議題ごと・質疑者ごとのまとまりに分ける。
// 設計: docs/工程3の設計.md の「まとまりの区切り方 / 委員会（T5）」
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/03e_committee.mjs                       すべて作り直す（10秒ほど）
//   node pipeline/03e_committee.mjs --show <file>         1日分のまとまりを一覧にして見る（抜き取りの確認用。何も書き出さない）
//                                                         <file> は data/md からの相対パス（2016/2016-02-29_k3_3178.md）
//
// 入力: data/struct/speeches/<年>.jsonl、data/struct/meetings.jsonl（T1）
//       data/struct/toc.jsonl（T2。特別委員会の照合に使う。なければ照合を飛ばす）
//       pipeline/members/members.csv、aliases.csv（T3。なければ faction は空）
// 出力: data/struct/exchanges/<年>-k3.jsonl
//
// 毎回すべて作り直す。何度実行しても同じ結果になる。最後に検証の件数を出す。

import { readFile, readdir, writeFile, mkdir, rename, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 会派の名簿（T3）の引き方は、lib.mjs の loadMembers（設計書の「会派の名簿」のとおり）
import { normalizeName, speechUrl, loadMembers } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const STRUCT = path.join(ROOT, "data", "struct");
const OUT = path.join(STRUCT, "exchanges");
const MEMBERS = path.join(here, "members");

const exists = (p) => access(p).then(() => true, () => false);
const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bodyOf = (sp) => sp.text.slice(sp.head?.length ?? 0).replace(/^[\s　]+/, "");
const sentencesOf = (body) => body.split(/[。\n]/).map((s) => s.replace(/^[\s　]+|[\s　]+$/g, "")).filter(Boolean);

// ---------- 委員長の発言を読む ----------

// 進行の決まり文句。1文がこれに当たれば進行の文とみる
const PROGRESS = [
  /^(?:(?:それでは|では|ただいまから|これより|引き続き|休憩前に引き続き)、?)?(?:[^、]{0,30}委員会を)?(?:再開|開会|開議)(?:いた)?します$/,
  /^(?:ただいまから|これより)、?.{0,30}(?:を開会|を開議|を再開)(?:いた)?します$/,
  /(?:暫時休憩|休憩|散会|閉会)(?:いた)?します$/,
  /を議題と(?:いたします|し、|します)/,
  /^(?:(?:それでは|では|次に|これより|ここで|なければ|休憩前に引き続き|引き続き|前回に引き続き|改めて)、?)?(?:質疑|討論)(?:を(?:行います|終了いたします|続行いたします|続けます)|に入ります)$/,
  /^(?:以上で|なければ)、.{0,120}(?:質疑|討論)を終了(?:いた)?します$/,
  /の?質疑を(?:行います|行いますが)/,
  /(?:ございませんか|ありませんか)$/,
  /(?:お諮りいたします|挙手を求めます|と決定いたしました|と認めます|と決定することに)/,
  /^(?:それでは、)?採決を行います$/,
  /説明を(?:受けます|求めます|お願いします)$/,
  /^(?:傍聴人に申し上げます|傍聴席|静粛に|お静かに)/,
  /^(?:.{1,15}、)?答弁を(?:求めます|続けてください|お願いします|お願いいたします|してください)$/,
  /^.{1,15}、(?:質問に)?(?:答えて|お答え)ください$/,
  /^.{1,20}委員、.{0,50}(?:ください|願います|お願いします)$/,
  // 次の質疑者を呼ぶ: 「それでは米倉委員」「はい、勝木委員」
  /^(?:(?:それでは|では|次に|はい)、?)?[^、]{1,12}委員(?:、どうぞ)?$/,
];
const isProgressSentence = (s) => s.length <= 160 && PROGRESS.some((re) => re.test(s));

// 質問・討論・意見らしさ（副委員長などが質問しているかの判断に使う）
const QUESTION_LIKE = /(伺い|伺います|お聞き|お尋ね|質問|求めたい|べき|ではないか|いかがか|要望|お願いしたい|思います|考えます|討論|私から|私は|我が会派)/;
// 就任挨拶など
const CEREMONY = /(選任|就任|互選|推挙|推薦|大任|信任|拝命|ご指名をいただ|任をと|同意をいただ|挨拶|あいさつ|と申します|でございます。)/;

export function isProgress(body) {
  const ss = sentencesOf(body);
  const prog = ss.filter(isProgressSentence);
  if (!prog.length) return false;
  // 長い発言は、最初の文が進行で、意見の言葉が少ないときだけ
  if (body.length > 300) return isProgressSentence(ss[0]) && !/(私は|我が会派|立場から|伺います|質問いたします)/.test(body);
  return !/(私は|私から|我が会派|立場から|立場で)/.test(body);
}

const CONNECTIVE = /^(?:それでは|では|次に|最初に|最後に|続いて|続きまして|引き続き|休憩前に引き続き|前回に引き続き|まず|初めに|これより|ここで|改めて|直ちに|議事に入ります)、?/;
function cleanAgenda(s) {
  let a = s;
  for (let i = 0; i < 3; i++) a = a.replace(CONNECTIVE, "");
  a = a.replace(/[、\s　]*(?:について|に対する|に関する|につきまして)?[、\s　]*(?:一括して)?[、\s　]*(?:の)?$/, "");
  return a.replace(/^[\s　]+|[\s　]+$/g, "");
}

// 委員長（進行役）の発言から、議題の変わり目・段階・区切りを読む
export function chairEvents(body) {
  const ev = { agendas: [], phase: null, boundary: false, endQ: false, startQ: false };
  for (const s of sentencesOf(body)) {
    let m;
    // 「〜の質疑の終結を求める動議を議題として、直ちに採決を行います」は質疑の途中の採決なので、議題は変えない
    // （「松浦　忠議員に懲罰を科する動議を議題といたします」は議題）
    if ((m = s.match(/^(.+?)を(?:一括して|一括)?議題と(?:いたします|し|します|いたしたい)/)) && !(/動議/.test(m[1]) && /直ちに|採決/.test(s))) {
      const a = cleanAgenda(m[1]);
      if (a) ev.agendas.push(a), (ev.boundary = true), (ev.phase = "none");
    }
    // 「それでは、松浦議員に対し、質疑を行います」: その議員が答える側になる
    if ((m = s.match(/^(?:.*?、)?([^、]+?)議員に対し(?:て)?、?質疑を行います/))) ev.respondent = normalizeName(m[1]);
    else if (/質疑を(?:終了|終結)/.test(s)) ev.respondent = null;
    // 「次に、第２款　総務費　第４項　選挙費の質疑を行います」「〜について、一括して審議を行います」
    if ((m = s.match(/^(.*?)(?:(?:質疑|審議|審査)を(?:行います|行いますが|行う|続行|いたします)|一括質疑を)/))) {
      let a = cleanAgenda(m[1]);
      // 「保留になっておりました松浦委員の質疑を行います」は、ある委員の保留分なので議題は変えない
      // ただし「保留しておりました松浦委員の質疑のうち、第３項　老人福祉費等について」は、後ろの款項を議題にする
      if (/保留|委員の/.test(a)) {
        const tail = cleanAgenda(a.split(/のうち、/).pop());
        a = tail !== a && /款|項|議案|会計/.test(tail) ? tail : null;
        ev.boundary = true;
      }
      if (a && !/討論|休憩前|引き続き|先ほど|^本日|^以上|議員に対し(?:て)?$/.test(a)) ev.agendas.push(a), (ev.boundary = true);
      ev.phase = "質疑";
      ev.startQ = true;
    } else if (/質疑に入ります|質疑を続け|質問を行います/.test(s)) (ev.phase = "質疑"), (ev.startQ = true);
    if (/質疑を(?:終了|終結)/.test(s) && !/質疑を終了したいと|ほかに/.test(s)) (ev.endQ = true), (ev.boundary = true), (ev.phase = "none");
    // 「次に、討論を行います」「本委員会に付託されました全案件に対する討論を行います」。進行役の発言だけを見るので、委員の討論の宣言とは混ざらない
    if (/討論(?:を行います|を行いますが|に入ります|を続行)/.test(s) && !/通告がありません/.test(s)) (ev.phase = "討論"), (ev.boundary = true);
    if (/討論を(?:終了|終結|集結)/.test(s)) (ev.phase = "none"), (ev.boundary = true);
    // 第１号の「副委員長の互選を行います」。このあとの推薦の動議は、目次では●で載らない
    if (/副委員長の互選|互選を行います/.test(s)) (ev.phase = "互選"), (ev.boundary = true);
    if (/^(?:それでは、)?採決を行います$/.test(s) || /採決を行います$/.test(s)) (ev.phase = "none"), (ev.boundary = true);
    if (/説明を(?:受けます|求めます|お願いします|いただきます)$/.test(s)) (ev.phase = "説明"), (ev.boundary = true);
    if (/(?:散会|閉会)(?:いた)?します$/.test(s)) (ev.phase = "none"), (ev.boundary = true);
  }
  return ev;
}

// ---------- 1日分を区切る ----------

export function segment(meeting, list) {
  const exs = [];
  const st = { presider: null, agenda: null, agendaNo: 0, segNo: 0, phase: "none", cur: null, lastQ: null, respondent: null };
  const turns = []; // 質疑者が入れ替わった順（目次との照合用）: { name, agendaNo }
  const notes = { chairQuestion: [], chairOther: [] };
  const chairNames = new Set(); // 委員長の側で発言した人（目次との照合で外す）

  const open = (type, sp, extra = {}) => {
    const ex = {
      id: sp.huid, type, file: meeting.file, date: meeting.date, kind: meeting.kind,
      session: meeting.session, term: meeting.term, committee: meeting.committee, committee_type: meeting.committeeType,
      agenda: st.agenda, questioner: null, faction: null, related_to: null, items: null,
      answerers: [], huids: [], chars: 0, url: speechUrl(meeting.viewer, sp.huid),
      ...extra,
    };
    Object.defineProperty(ex, "_agendaNo", { value: st.agendaNo, enumerable: false });
    Object.defineProperty(ex, "_segNo", { value: st.segNo, enumerable: false });
    Object.defineProperty(ex, "_phase", { value: st.phase, enumerable: false });
    exs.push(ex);
    st.cur = ex;
    add(ex, sp);
    return ex;
  };
  // 同じ議題の中で、委員長の区切り（質疑の終了、採決など）をはさまずに、その委員のまとまりのあとに
  // 割り込み（関連質疑、または答弁のない発言）しかなければ、そのまとまりを返す
  const resumable = (name) => {
    for (let k = exs.length - 1; k >= 0; k--) {
      const e = exs[k];
      if (e._segNo !== st.segNo || e.type === "説明" || e.type === "討論") return null;
      if (e.questioner === name) return e;
      if (!e.related_to && e.answerers.length) return null;
    }
    return null;
  };
  const add = (ex, sp) => {
    ex.huids.push(sp.huid);
    ex.chars += sp.chars;
    if (sp._as === "answer" && !ex.answerers.some((a) => a.title === sp.title && a.name === sp.name)) ex.answerers.push({ title: sp.title, name: sp.name });
  };

  for (let i = 0; i < list.length; i++) {
    const sp = list[i];
    const body = bodyOf(sp);
    // 発言者の扱い: 役職で決める。○で役職が委員のもの（記号の付け間違い）は委員長の側に寄せる
    // 進行役と同じ人が委員の役職で進行している（記号・役職の付け間違い。「◆大嶋薫　委員　　以上で、…の質疑を終了いたします」）も委員長の側
    const chairSide = sp.role === "chair" || (sp.mark === "○" && sp.role === "member") || (sp.role === "member" && sp.name === st.presider && body.length < 300 && isProgress(body));
    if (chairSide && sp.name) chairNames.add(sp.name);
    let as;
    if (sp.role === "official") as = "answer";
    // 懲罰特別委員会などで「松浦議員に対し、質疑を行います」と委員会が議員に質疑するとき、その議員は◆でも答える側
    else if (st.respondent && sp.role === "member" && sp.name?.startsWith(st.respondent)) as = "answer";
    else if (!chairSide) as = "question";
    // 参考人の意見を聴く会などで、議長があいさつするもの
    // （答弁者には入れず、説明のまとまりに入れる）
    else if (/^(?:議長|副議長)$/.test(sp.title) && sp.name !== st.presider) as = "statement";
    else if (!st.presider || sp.name === st.presider) (st.presider ??= sp.name), (as = "chair");
    else {
      // 進行役でない委員長・副委員長: 進行を代わったのか、質問しているのか
      const nextAnswer = list.slice(i + 1).find((t) => !(t.role === "chair" && t.name === st.presider))?.role === "official";
      if (st.cur?.questioner === sp.name && !(body.length < 120 && isProgress(body))) as = "question";
      else if (isProgress(body) && !(body.length >= 150 && QUESTION_LIKE.test(body) && nextAnswer)) (st.presider = sp.name), (as = "chair");
      else if (body.length < 600 && CEREMONY.test(body.slice(0, 80))) as = "other";
      else if (st.phase === "討論" && body.length >= 80) as = "question";
      else if (nextAnswer || (body.length >= 80 && QUESTION_LIKE.test(body))) as = "question";
      else as = "other";
      if (as === "question" && st.cur?.questioner !== sp.name) notes.chairQuestion.push(`${meeting.file} HUID${sp.huid} ${sp.name}${sp.title}: ${body.slice(0, 40)}`);
      if (as === "other") notes.chairOther.push(`${meeting.file} HUID${sp.huid} ${sp.name}${sp.title}: ${body.slice(0, 40)}`);
    }
    sp._as = as;

    if (as === "chair") {
      const ev = chairEvents(body);
      const closesExplanation = ev.startQ && st.cur?.type === "説明";
      if (ev.boundary || closesExplanation) (st.cur = null), st.segNo++;
      else if (st.cur) add(st.cur, sp);
      for (const a of ev.agendas) (st.agenda = a), st.agendaNo++, (st.lastQ = null), (st.respondent = null);
      if (ev.respondent !== undefined) st.respondent = ev.respondent;
      if (ev.phase) st.phase = ev.phase;
      else if (st.phase === "互選" && /選任されました|決定いたしました|と決しました|就任/.test(body)) st.phase = "none";
    } else if (as === "answer" || as === "statement") {
      if (st.cur) add(st.cur, sp);
      else open("説明", sp);
    } else if (as === "question") {
      const related = /関連/.test(sp.note ?? "");
      const cur = st.cur;
      const resume = !related && st.phase !== "討論" && cur?.questioner !== sp.name ? resumable(sp.name) : null;
      if (cur && cur.questioner === sp.name && !related && cur.type !== "説明") add(cur, sp);
      else if (resume) {
        // 関連質疑・動議・議事進行などが割り込んだあと、元の委員が続ける: 元のまとまりに戻す
        st.cur = resume;
        add(resume, sp);
      } else {
        const relatedTo = related ? (cur && cur.type === "質疑" && cur.questioner !== sp.name ? cur.id : st.lastQ?.id ?? null) : null;
        const ex = open(st.phase === "討論" ? "討論" : "質疑", sp, { questioner: sp.name, related_to: relatedTo });
        if (ex.type === "質疑" && !related) st.lastQ = ex;
        // 副委員長の互選での推薦の動議は、目次では●で載らないので、照合で数えない印を付ける
        const nomination = st.phase === "互選" && /推薦|推選/.test(body.slice(0, 120));
        turns.push({ name: sp.name, agendaNo: st.agendaNo, phase: st.phase, chairSide, nomination, ex });
      }
    } else if (st.cur) add(st.cur, sp);
  }

  // 種類の仕上げ: 答弁のない質疑は「その他」（動議、議事進行、協議、要望だけの発言など）。関連質疑は質疑のまま
  for (const ex of exs) {
    if (ex.type === "質疑" && !ex.answerers.length && !ex.related_to) ex.type = "その他";
  }
  return { exs, turns, notes, chairNames };
}

// ---------- 目次との照合で使う小さな関数 ----------

// 目次の●（質疑する側）のうち、委員・議員として書かれたもの。委員長・副委員長は別に扱う
const isQuestionerInToc = (s) => s.mark === "●" && /^(委員|議員)$/.test(s.title ?? "") && s.name;
const collapse = (a) => a.filter((x, i) => i === 0 || x !== a[i - 1]);
const uniq = (a) => [...new Set(a)];

// ---------- 本体 ----------

async function writeAtomic(p, text) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(`${p}.part`, text);
  await rename(`${p}.part`, p);
}

async function main() {
  const args = process.argv.slice(2);
  const show = args.includes("--show") ? args[args.indexOf("--show") + 1] : null;

  const meetings = await readJsonl(path.join(STRUCT, "meetings.jsonl"));
  const byFile = new Map(meetings.map((m) => [m.file, m]));
  const { canon, factionOf } = await loadMembers(MEMBERS);

  const years = (await readdir(path.join(STRUCT, "speeches"))).filter((f) => /^\d{4}\.jsonl$/.test(f)).map((f) => f.slice(0, 4)).sort();
  const report = { uncovered: [], dup: [], tocMismatch: [], tocLoose: [], tocGroups: [], tocChair: [], tocMissing: [], noAgenda: [], noFaction: 0, markRole: [], chairQuestion: [], chairOther: [] };
  const turnsByFile = new Map();
  const chairNamesByFile = new Map();
  const counts = {};
  let total = 0;

  for (const year of show ? [show.slice(0, 4)] : years) {
    const speeches = (await readJsonl(path.join(STRUCT, "speeches", `${year}.jsonl`))).filter((s) => s.kind === "委員会");
    const files = new Map();
    for (const s of speeches) {
      if (!files.has(s.file)) files.set(s.file, []);
      files.get(s.file).push(s);
    }
    const out = [];
    const sorted = [...files.keys()].sort((a, b) => byFile.get(a).date.localeCompare(byFile.get(b).date) || byFile.get(a).fino - byFile.get(b).fino);
    for (const file of sorted) {
      if (show && file !== show) continue;
      const meeting = byFile.get(file);
      const list = files.get(file).sort((a, b) => a.seq - b.seq);
      const { exs, turns, notes, chairNames } = segment(meeting, list);
      turnsByFile.set(file, turns);
      chairNamesByFile.set(file, chairNames);
      report.chairQuestion.push(...notes.chairQuestion);
      report.chairOther.push(...notes.chairOther);

      // 検証: ◆と◎（答弁）がすべてどこかに入っているか、二重に入っていないか
      const seen = new Map();
      for (const ex of exs) for (const h of ex.huids) {
        if (seen.has(h)) report.dup.push(`${file} HUID${h}: ${seen.get(h)} と ${ex.id}`);
        seen.set(h, ex.id);
      }
      for (const s of list) {
        // ◆と◎は、委員長の進行として扱ったもの（記号の付け間違い。下の「記号と役職が合わない」に出す）を除いて、すべて入っているはず
        const shouldBeIn = s._as === "question" || s._as === "answer" || s._as === "statement" || ((s.mark === "◆" || s.mark === "◎") && s._as !== "chair");
        if (shouldBeIn && !seen.has(s.huid)) report.uncovered.push(`${file} HUID${s.huid} ${s.head}: ${bodyOf(s).slice(0, 30)}`);
        if ((s.mark === "◎" && s.role === "member") || (s.mark === "◆" && s.role !== "member") || (s.mark === "○" && s.role === "member") || (s.role === "member" && s._as === "chair"))
          report.markRole.push(`${file} HUID${s.huid} ${s.head} → ${s._as === "answer" ? "答弁" : s._as === "question" ? "質疑者" : "進行"}として扱った`);
      }
      for (const ex of exs) {
        if (ex.questioner && factionOf) ex.faction = factionOf(ex.term, ex.questioner, ex.date);
        if (ex.questioner && !ex.faction) report.noFaction++;
        if (ex.type === "質疑" && !ex.agenda && /^(予算|決算|議案審査)特別$/.test(ex.committee_type ?? "")) report.noAgenda.push(`${file} ${ex.id} ${ex.questioner}`);
        const k = `${ex.committee_type}\t${ex.type}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      out.push(...exs);

      if (show) {
        console.log(`${file} ${meeting.meeting} ${meeting.label}（${meeting.committeeType}）`);
        const bySp = new Map(list.map((s) => [s.huid, s]));
        for (const ex of exs) {
          const qs = ex.huids.map((h) => bySp.get(h));
          console.log(`\n[${ex.type}] id=${ex.id} 質疑者=${ex.questioner ?? "-"}${ex.related_to ? ` 関連元=${ex.related_to}` : ""} 発言${ex.huids.length}件 ${ex.chars}字`);
          console.log(`  議題: ${ex.agenda ?? "-"}`);
          console.log(`  答弁: ${ex.answerers.map((a) => `${a.name ?? ""}${a.title}`).join("、") || "-"}`);
          for (const s of qs) console.log(`    ${s.seq} ${s.head} | ${bodyOf(s).slice(0, 50).replace(/\n/g, "⏎")}`);
        }
        const outside = list.filter((s) => !seen.has(s.huid));
        console.log(`\nまとまりに入っていない発言 ${outside.length} 件（委員長の進行など）`);
        for (const s of outside) console.log(`    ${s.seq} ${s.head} | ${bodyOf(s).slice(0, 60).replace(/\n/g, "⏎")}`);
        return;
      }
    }
    total += out.length;
    await writeAtomic(path.join(OUT, `${year}-k3.jsonl`), out.map((e) => JSON.stringify(e)).join("\n") + "\n");
    console.log(`[${year}] 委員会 ${sorted.length} 日分 / まとまり ${out.length} 件`);
  }

  // 検証: 特別委員会（予算・決算・議案審査・懲罰）は、号ごとの質疑者の並びと議題の区切りを目次（T2 の toc.jsonl）と照合する
  // 照合のしかた（どれも、目次の書き方に合わせたもの。設計書の「T5 の結果」に例がある）:
  // - 本文は、質疑者が入れ替わった順に名前を並べる。関連質疑や動議が割り込んだあと元の委員が続けたもの（元のまとまりに戻したもの）は数えない。目次も載せ直さない
  // - 目次は、同じ議題で同じ委員が2回目に出るのを載せることも載せないこともある。厳密に合わなければ、議題ごとに初めて出た順で比べ直す
  // - 委員長・副委員長は、目次では「●氏名委員長」と書かれ、進行中の口添えと質問の区別がない。委員長が委員として質問すると、本文は「◆氏名　委員」、
  //   目次は「●氏名委員長」になる。そこで、その日に委員長の側で発言した人と、目次で委員長・副委員長と書かれた人を、名前で両方から外す。
  //   本文で委員長・副委員長の質疑とみたものは、その号の目次の●に名前があるかを別に確かめる
  // - 副委員長の互選での推薦の動議は数えない（目次では●で載らない）
  // - T2 が、同じ議題の中の「発言」を別の項目に分けたもの（目次では質疑の並びのあとにまとめて載る）は、本文のどこに入るかがわからないので、その人を両方から外す
  // - 氏名は aliases.csv で寄せてから比べる（本文の誤字「森喜誉則」など）
  const tocPath = path.join(STRUCT, "toc.jsonl");
  const tocRows = (await exists(tocPath)) ? (await readJsonl(tocPath)).filter((r) => r.kind === "委員会") : null;
  let checked = 0;
  for (const row of tocRows ?? []) {
    const m = byFile.get(row.file);
    if (!m) {
      report.tocMissing.push(`${row.toc_file} の ${row.issue}: 本文の会議 ${row.file} が meetings.jsonl にない`);
      continue;
    }
    checked++;
    const N = (n) => canon(normalizeName(n));
    const sameAgendaRemark = (e, i) => e.type === "発言" && i > 0 && e.agenda && row.entries[i - 1].agenda === e.agenda;
    const turnsAll = (turnsByFile.get(m.file) ?? []).filter((t) => !t.nomination);
    const chairNames = new Set([
      ...[...(chairNamesByFile.get(m.file) ?? [])].map(N),
      ...row.entries.flatMap((e) => (e.speakers ?? []).filter((s) => s.mark === "●" && /委員長$/.test(s.title ?? "") && s.name).map((s) => N(s.name))),
    ]);
    const remarkNames = new Set(row.entries.flatMap((e, i) => (sameAgendaRemark(e, i) ? (e.speakers ?? []).filter((s) => s.name).map((s) => N(s.name)) : [])));
    const keep = (n) => !chairNames.has(n) && !remarkNames.has(n);
    const groupsT = row.entries
      .filter((e, i) => !sameAgendaRemark(e, i))
      .map((e) => (e.speakers ?? []).filter(isQuestionerInToc).map((s) => N(s.name)).filter(keep))
      .filter((g) => g.length);
    const tocAll = new Set(row.entries.flatMap((e) => (e.speakers ?? []).filter((s) => s.mark === "●" && s.name).map((s) => N(s.name))));
    for (const t of turnsAll.filter((t) => t.chairSide)) if (!tocAll.has(N(t.name))) report.tocChair.push(`${m.file}（${m.committee} ${m.issue}）: ${t.name}`);
    // 本文: 議題ごと（目次と同じく、説明・質疑・討論も分ける）に、質疑者が入れ替わった順
    const groupsB = [];
    let lastKey = null;
    for (const t of turnsAll.filter((t) => !t.chairSide && keep(N(t.name)))) {
      const key = `${t.agendaNo}\t${t.phase === "討論" || t.phase === "説明" ? t.phase : ""}`;
      if (key !== lastKey) groupsB.push([]), (lastKey = key);
      groupsB[groupsB.length - 1].push(N(t.name));
    }
    const flatT = collapse(groupsT.map(collapse).flat());
    const flatB = collapse(groupsB.map(collapse).flat());
    // 目次は、同じ議題で同じ委員が2回目に出るのを載せることも載せないこともある。厳密に合わなければ、議題ごとに初めて出た順で比べ直す
    const looseT = collapse(groupsT.map(uniq).flat());
    const looseB = collapse(groupsB.map(uniq).flat());
    const sizes = (gs) => gs.map((g) => uniq(g).length).join(",");
    if (flatT.join("/") === flatB.join("/")) {
      if (sizes(groupsT) !== sizes(groupsB)) report.tocGroups.push(`${m.file}（${m.committee} ${m.issue}）: 議題ごとの人数 目次 ${sizes(groupsT)} / 本文 ${sizes(groupsB)}`);
    } else if (looseT.join("/") === looseB.join("/")) {
      report.tocLoose.push(`${m.file}（${m.committee} ${m.issue}）`);
    } else {
      let k = 0;
      while (k < looseT.length && looseT[k] === looseB[k]) k++;
      report.tocMismatch.push(`${m.file}（${m.committee} ${m.issue}）: ${k + 1}人目から違う。目次 ${looseT.slice(k, k + 4).join("、") || "（なし）"} / 本文 ${looseB.slice(k, k + 4).join("、") || "（なし）"}（目次 ${looseT.length}人・本文 ${looseB.length}人）`);
    }
  }
  // 目次のある委員会の号で、toc.jsonl に載っていないもの
  if (tocRows) {
    const inToc = new Set(tocRows.map((r) => r.file));
    for (const m of meetings)
      if (/^(予算特別|決算特別|議案審査特別)$/.test(m.committeeType ?? "") && /^\d+号$/.test(m.issue ?? "") && !inToc.has(m.file)) report.tocMissing.push(`${m.file}（${m.committee} ${m.issue}）: 目次（toc.jsonl）にこの号がない`);
  }

  console.log(`\n完了: まとまり ${total} 件 / 出力 data/struct/exchanges/<年>-k3.jsonl`);
  console.log(tocRows ? `目次との照合: 特別委員会の号 ${checked} 件` : "目次との照合: data/struct/toc.jsonl（T2）がないので飛ばした");
  console.log(`会派の名簿: ${factionOf ? "pipeline/members/members.csv" : "まだない（faction は空。T3 のあと流し直す）"}`);
  console.log("\n委員会の種類 × まとまりの種類:");
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.replace("\t", " × ")}: ${v}`);
  console.log("");
  const rows = [
    ["◆か◎の発言がどのまとまりにも入っていない", report.uncovered],
    ["1つの発言が2つのまとまりに入っている", report.dup],
    ["特別委員会: 号ごとの質疑者の並びが目次と違う", report.tocMismatch],
    ["特別委員会: （一致とみなす）議題ごとに初めて出た順なら一致する（同じ議題で同じ委員が2回目に出るのを、目次が載せる・載せないの違い）", report.tocLoose],
    ["特別委員会: （一致とみなす）並びは同じだが、議題の区切りが目次と違う", report.tocGroups],
    ["特別委員会: 委員長・副委員長の質疑とみたが、その号の目次の●に名前がない", report.tocChair],
    ["特別委員会: 目次と本文の号が対応しない", report.tocMissing],
    ["特別委員会: 議題が決まらない質疑", report.noAgenda],
    ["記号と役職が合わない（役職で扱いを決めた）", report.markRole],
    ["（確認用）進行役でない委員長・副委員長の発言を質疑とみた", report.chairQuestion],
    ["（確認用）進行役でない委員長・副委員長の発言で、進行でも質疑でもないとみた（就任挨拶など。まとまりに入れない）", report.chairOther],
  ];
  for (const [label, list] of rows) {
    console.log(`${label}: ${list.length} 件`);
    for (const l of list.slice(0, 20)) console.log(`  ${l}`);
    if (list.length > 20) console.log(`  ほか ${list.length - 20} 件`);
  }
  console.log(`会派が空の質疑者のまとまり: ${report.noFaction} 件${factionOf ? "" : "（名簿がまだないため）"}`);
  if (report.uncovered.length || report.dup.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`エラー: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
