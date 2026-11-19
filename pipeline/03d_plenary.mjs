#!/usr/bin/env node
// 工程3 T4: 本会議（定例会・臨時会）の発言（data/struct/speeches）を、議長が指名した1人分ずつのまとまりに分ける。
// 設計: docs/工程3の設計.md の「まとまりの区切り方 / 本会議（T4）」
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/03d_plenary.mjs                       すべて作り直す（数秒）
//   node pipeline/03d_plenary.mjs --show <file>         1日分のまとまりを一覧にして見る（抜き取りの確認用。何も書き出さない）
//                                                       <file> は data/md からの相対パス（2024/2024-02-20_k1_4349.md）
//   node pipeline/03d_plenary.mjs --all                 検証の一覧を20件で切らずにすべて出す
//
// 区切り方（設計書の約束に、調べて足したもの）:
// - 1人分は、議長がある議員を指名してから、次に別の議員を指名するまで。休憩では区切らない
// - 種類は、直前の議長の発言の言い回し（PHASES）で決める。目次（T2）は照合と大項目にだけ使う
// - ◎の答弁と同じ議員の再質問は、そのまとまりに入れる。委員長報告・議員提出の議案への質疑では、委員長・提出者が◆で答える
// - 動議の提出と議事進行の発言は、質疑・討論の途中でも「その他」
// - 文書質問は、質問と答弁書の本文が会議録にないので、まとまりにしない
//
// 入力: data/struct/speeches/<年>.jsonl、data/struct/meetings.jsonl（T1）
//       data/struct/toc.jsonl（T2。代表質問・質疑の大項目と、照合に使う）
//       pipeline/members/members.csv、aliases.csv（T3。なければ faction は空）
// 出力: data/struct/exchanges/<年>-k1.jsonl（定例会）、<年>-k2.jsonl（臨時会）
//
// 毎回すべて作り直す。何度実行しても同じ結果になる。最後に検証の件数を出す。

import { readFile, readdir, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeName, speechUrl, toHalfDigits, loadMembers } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const STRUCT = path.join(ROOT, "data", "struct");
const OUT = path.join(STRUCT, "exchanges");
const MEMBERS = path.join(here, "members");

const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bodyOf = (sp) => sp.text.slice(sp.head?.length ?? 0).replace(/^[\s　]+/, "");
const sentencesOf = (body) => body.split(/[。\n]/).map((s) => s.replace(/^[\s　]+|[\s　]+$/g, "")).filter(Boolean);

// 質問と答弁が往復する種類。答弁（◎）と再質問は、同じまとまりに入れる
const QA = new Set(["代表質問", "質疑"]);

// ---------- 議長の発言を読む ----------

// 段階を決める言い回し。1つの発言の中で出てきた順に当てはめ、あとのものが勝つ
// （「質疑がなければ、討論に入ります」は討論、「質疑に入りますが、通告がありませんので、質疑を終了します」は none）
const PHASES = [
  [/代表質問(?:を行います|を続行|に入ります)/g, "代表質問"],
  // 無所属・1人会派の議員の質問。目次では「代表質問の続行」の見出しがない（T2 で代表質問として読んだもの）
  [/(?<!代表)質問を(?:行います|続行します)/g, "代表質問"],
  // 「委員報告を求めます」（2013年4月5日。原文の誤り）も委員長報告
  [/委員(?:長)?(?:の)?報告(?:及び(?:提案|趣旨)?説明)?を求めます/g, "委員長報告"],
  [/質疑に入ります|質疑を行います|質疑を続行|質疑は(?:ありませんか|ございませんか)/g, "質疑"],
  [/討論に入ります|討論を行います|討論を続行|討論の通告があります/g, "討論"],
  // 「委員長報告及び提案説明を求めます」（委員会提出の議案）は委員長報告
  [/(?<!報告及び(?:提案|趣旨)?)(?:提案|趣旨)?説明を求めます/g, "説明"],
  // 「松浦議員の討論を終了します」「討論を終了してください」は1人の発言を打ち切るもので、討論は続く
  [/通告がありません|(?<!の)(?:質疑|討論)を(?:終了|終結)(?!してください)|採決に入ります|採決を行います|を(?:一括)?問題とします|散会します|延会します|閉会します|代表質問は(?:全て|すべて)終了/g, "none"],
  // 進行の報告、選挙、選任、紹介、あいさつ、追悼演説、意見陳述、市長などの申し出による発言。どれも「その他」のまとまりになる
  // （「委員長報告の範囲の中で発言を許可します」は質疑の中なので、「発言を許可します」だけでは段階を変えない。
  //   「意見陳述人に申し上げます。意見陳述時間となりましたので」も陳述の途中。
  //   「次に、金子やすゆき議員の発言を許します」は、決議案の説明のあとの本人の発言なので「その他」）
  [/諸般の報告|選挙を行います|ご紹介(?:します|いたします)|ごあいさつ|挨拶|あいさつ|追悼|申し出がありますので|の発言を許します|意見(?:の)?陳述を(?:求め|行い|許し)/g, "その他"],
];

// 議題: 「次に、日程第２、議案第１号から…諮問第１号の51件を一括議題といたします」→「日程第２　議案第１号から…諮問第１号」
// （目次の議題と同じ書き方にそろえる。「さらに、日程に追加して、…を議題とします」は「追加日程　…」）
function agendaOf(s) {
  let m = s.match(/(日程第[０-９\d]+)、?(.+?)を(?:一括)?議題と(?:いた)?し/);
  let head;
  if (m) head = m[1];
  else if ((m = s.match(/日程に追加して、?(.+?)を(?:一括)?議題と(?:いた)?し/))) (head = "追加日程"), (m = [m[0], head, m[1]]);
  else return null;
  const rest = m[2].replace(/の[０-９\d]+件$/, "").replace(/^[\s　]+|[\s　]+$/g, "");
  return `${head}　${rest}`;
}

export function chairEvents(body) {
  const ev = { agenda: null, phases: [], answerReq: false, next: false };
  const hits = [];
  for (const [re, phase] of PHASES) for (const m of body.matchAll(re)) hits.push({ i: m.index, phase });
  hits.sort((a, b) => a.i - b.i);
  for (const s of sentencesOf(body)) {
    const a = agendaOf(s);
    if (a) {
      ev.agenda = a;
      // 議題を変えたら、その文より前の段階は消す（議題の文の位置で none をはさむ）
      hits.push({ i: body.indexOf(s), phase: "none" });
    }
    if (/答弁を求めます|答弁願います/.test(s)) ev.answerReq = true;
    // 「次に、財政市民委員長　かんの太一議員」「まず、松浦　忠議員」: 次の人の指名
    if (/^(?:次に|まず|最初に|続いて)、/.test(s) && !/問題とします|議題と/.test(s)) ev.next = true;
  }
  hits.sort((a, b) => a.i - b.i);
  ev.phases = hits.map((h) => h.phase);
  return ev;
}

// 動議の提出と議事進行の発言（最初の文で見る）。質疑・討論の途中に出てきても「その他」
// （「〜を求める動議について、提案説明を行います」「動議には反対の立場で、討論を行います」「議長の適切な議事進行によって」は当たらない）
const MOTION = /動議を提出|動議です|動議であります|^(?:議長、)?議事進行|議事進行(?:について|の動議)/;
const isMotion = (sp) => MOTION.test(sentencesOf(bodyOf(sp))[0] ?? "");

// ---------- 1日分を区切る ----------

export function segment(meeting, list) {
  const exs = [];
  const st = { phase: "none", agenda: null, cur: null, pending: [], changed: false, next: false, answerReq: false };

  const add = (ex, sp, as) => {
    ex.huids.push(sp.huid);
    ex.chars += sp.chars;
    if (as === "answer" && !ex.answerers.some((a) => a.title === sp.title && a.name === sp.name)) ex.answerers.push({ title: sp.title, name: sp.name });
  };
  const open = (type, sp, extra = {}) => {
    const ex = {
      id: sp.huid, type, file: meeting.file, date: meeting.date, kind: meeting.kind,
      session: meeting.session, term: meeting.term, committee: null, committee_type: null,
      agenda: st.agenda, questioner: null, faction: null, related_to: null, items: null,
      answerers: [], huids: [], chars: 0, url: speechUrl(meeting.viewer, sp.huid),
      ...extra,
    };
    exs.push(ex);
    st.cur = ex;
    return ex;
  };
  // 続けるときは、前の発言からのあいだの議長の発言（「答弁を求めます」「町田副市長」など）も入れる
  const join = (ex, sp, as) => {
    for (const c of st.pending) add(ex, c, "chair");
    add(ex, sp, as);
  };

  for (const sp of list) {
    if (sp.role === "chair") {
      const ev = chairEvents(bodyOf(sp));
      if (ev.agenda && ev.agenda !== st.agenda) (st.agenda = ev.agenda), (st.changed = true);
      for (const p of ev.phases) {
        // 「その他」は、出てくるたびに別の項目（諸般の報告のあとの「教育委員をご紹介します」など）
        if (p !== st.phase || p === "その他") st.changed = true;
        st.phase = p;
      }
      if (ev.answerReq) st.answerReq = true;
      if (ev.next) st.next = true;
      st.pending.push(sp);
      sp._as = "chair";
      continue;
    }

    const cur = st.cur;
    let as;
    // ◎（答弁する側）。役職が議員の◎は、議員提出の議案の提出者が答弁しているもの
    if (sp.mark === "◎" || sp.role === "official") {
      if (cur && QA.has(cur.type) && !st.changed) as = "answer";
      // 「（続）」は、議長の注意などをはさんで同じ人が続けたもの
      else if (cur && /^（続）/.test(bodyOf(sp)) && cur.answerers.some((a) => a.name === sp.name)) as = "answer";
      // 説明・あいさつなどは、同じ人が続けたときだけ同じまとまり（「静粛に願います」をはさんだ提案説明など）
      else if (cur && !QA.has(cur.type) && cur.questioner == null && cur.answerers[0]?.name === sp.name && !st.changed && !st.next) as = "answer";
      else as = "open-answer";
    } else {
      // ◆（議員）。委員長報告や議員提出の議案への質疑では、委員長・提出者（同じ議題で報告・説明をした議員）が◆で答える。
      // 議長が「答弁を求めます」と言うこともあるが、「細川正人委員長」「本郷議員」と名前を呼ぶだけのことも多い
      const responder = cur && QA.has(cur.type) && cur.questioner !== sp.name && !st.changed &&
        (st.answerReq || cur.answerers.some((a) => a.name === sp.name) || exs.some((e) => (e.type === "説明" || e.type === "委員長報告") && e.agenda === cur.agenda && e.questioner === sp.name));
      // 「（続）」で始まる発言は、議事進行などで割り込まれたあと、同じ人が自分の発言を続けたもの。議題が同じなら元のまとまりに戻す
      const resume = !responder && cur?.questioner !== sp.name && /^（続）/.test(bodyOf(sp))
        ? exs.findLast((e) => e.questioner === sp.name && e.agenda === st.agenda && e.type !== "その他") : null;
      if (responder) as = "answer";
      else if (cur && cur.questioner === sp.name && !st.changed && !st.next) as = "question";
      else if (resume) (as = "question"), (st.cur = resume);
      else as = "open-question";
    }

    if (as === "answer" || as === "question") join(st.cur, sp, as === "answer" ? "answer" : "question");
    else if (as === "open-answer") {
      const ex = open(st.phase === "説明" ? "説明" : "その他", sp);
      add(ex, sp, "answer");
    } else {
      const type = isMotion(sp) ? "その他" : QA.has(st.phase) || ["討論", "委員長報告", "説明"].includes(st.phase) ? st.phase : "その他";
      const ex = open(type, sp, { questioner: sp.name });
      add(ex, sp, "question");
    }
    sp._as = as.replace("open-", "");
    st.pending = [];
    st.changed = false;
    st.next = false;
    st.answerReq = false;
  }
  // 種類の仕上げ: 答弁のない短いまとまりで、本人の発言に動議・議事進行があるもの（「議長、私を指名していただきましたか」「議事進行の動議です」）は「その他」
  const bySp = new Map(list.map((s) => [s.huid, s]));
  for (const ex of exs) {
    if (ex.type === "その他" || QA.has(ex.type) && ex.answerers.length || !ex.questioner) continue;
    const own = ex.huids.map((h) => bySp.get(h)).filter((s) => s.name === ex.questioner && s.role === "member");
    if (own.reduce((n, s) => n + s.chars, 0) < 400 && own.some(isMotion)) ex.type = "その他";
  }
  return exs;
}

// ---------- 目次との照合で使う小さな関数 ----------

// 目次の種類 → まとまりの種類
const TOC_TYPE = { 代表質問: "代表質問", 質疑: "質疑", 討論: "討論", 委員長報告: "委員長報告", 提案説明: "説明" };
const tocType = (t) => TOC_TYPE[t] ?? "その他";
// 目次の名前は、代表質問・質疑・討論は氏名、委員長報告・提案説明・答弁者は姓だけ（同姓は「伊藤（理）」）
const tocName = (n) => (n ?? "").replace(/[（(][^）)]*[）)]/g, "").replace(/[\s　]/g, "");
// 本文の発言者（氏名）と目次の名前が同じ人か
const sameName = (body, toc, canon) => {
  if (!body || !toc) return false;
  const b = canon(normalizeName(body)), t = canon(tocName(toc));
  return b === t || b.startsWith(t);
};

// 市長の最初の答弁の「全体で９項目にわたり、ご質問をいただきました」の数
const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function itemCountOf(text) {
  // 最初の2文から探す（「ご質問、ありがとうございました。８点に及ぶご質問がございましたので」）
  let m = null;
  for (const head of sentencesOf(text).slice(0, 2)) {
    if (/再質問/.test(head)) return null;
    // 「全体で７項目、ご質問をいただきました」「11項目ございましたけれども」。「１項目め」は数えない
    // 2007〜2010年ごろは「８点ご質問でございましたが」「９点にわたりましてご質問がございました」
    m = head.match(/([０-９\d]+|[一二三四五六七八九十]+)項目(?![め目])/) ?? head.match(/^[^、。]{0,15}?([０-９\d]+|[一二三四五六七八九十]+)点[^、。]{0,10}?質問/);
    // 「私の政治姿勢について３点ご質問でありますので」は、1つの大項目の中の数
    if (m && /について|に関し|のうち|の中/.test(head.slice(0, m.index + m[0].indexOf(m[1])))) m = null;
    if (m) break;
  }
  if (!m) return null;
  const s = m[1];
  if (/[一二三四五六七八九十]/.test(s)) return s.length === 2 && s[0] === "十" ? 10 + KANJI[s[1]] : s.length === 2 ? KANJI[s[0]] * 10 : KANJI[s];
  return Number(toHalfDigits(s));
}

// ---------- 本体 ----------

async function writeAtomic(p, text) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(`${p}.part`, text);
  await rename(`${p}.part`, p);
}

async function main() {
  const args = process.argv.slice(2);
  const show = args.includes("--show") ? args[args.indexOf("--show") + 1] : null;
  const all = args.includes("--all");

  const meetings = await readJsonl(path.join(STRUCT, "meetings.jsonl"));
  const byFile = new Map(meetings.map((m) => [m.file, m]));
  const tocByFile = new Map((await readJsonl(path.join(STRUCT, "toc.jsonl"))).filter((r) => r.kind !== "委員会").map((r) => [r.file, r]));
  const { canon, factionOf } = await loadMembers(MEMBERS);

  const years = (await readdir(path.join(STRUCT, "speeches"))).filter((f) => /^\d{4}\.jsonl$/.test(f)).map((f) => f.slice(0, 4)).sort();
  const report = {
    uncovered: [], dup: [], qaMismatch: [], noItems: [], itemCount: [], itemCountNone: [], otherMismatch: [], answererMismatch: [],
    noToc: [], noFaction: [], noAgenda: [], memberAnswer: [], writtenQ: [],
  };
  const counts = {};
  let total = 0, checkedDays = 0, checkedQa = 0, checkedItems = 0;

  for (const year of show ? [show.slice(0, 4)] : years) {
    const speeches = (await readJsonl(path.join(STRUCT, "speeches", `${year}.jsonl`))).filter((s) => s.kind !== "委員会");
    const files = new Map();
    for (const s of speeches) {
      if (!files.has(s.file)) files.set(s.file, []);
      files.get(s.file).push(s);
    }
    const out = { 定例会: [], 臨時会: [] };
    const sorted = [...files.keys()].sort((a, b) => byFile.get(a).date.localeCompare(byFile.get(b).date) || byFile.get(a).fino - byFile.get(b).fino);
    for (const file of sorted) {
      if (show && file !== show) continue;
      const meeting = byFile.get(file);
      const list = files.get(file).sort((a, b) => a.seq - b.seq);
      const exs = segment(meeting, list);
      const toc = tocByFile.get(file);
      if (!toc) report.noToc.push(file);

      // 検証: ◆と◎がすべてどこかに入っているか、二重に入っていないか
      const seen = new Map();
      for (const ex of exs) for (const h of ex.huids) {
        if (seen.has(h)) report.dup.push(`${file} HUID${h}: ${seen.get(h)} と ${ex.id}`);
        seen.set(h, ex.id);
      }
      for (const s of list) {
        if ((s.mark === "◆" || s.mark === "◎") && !seen.has(s.huid)) report.uncovered.push(`${file} HUID${s.huid} ${s.head}: ${bodyOf(s).slice(0, 30)}`);
        if (s.mark === "◆" && s._as === "answer") report.memberAnswer.push(`${file} HUID${s.huid} ${s.name}${s.title}（${exs.find((e) => e.huids.includes(s.huid))?.questioner} の${exs.find((e) => e.huids.includes(s.huid))?.type}に答弁）`);
      }

      // 目次（T2）と照合する。代表質問・質疑は、質問者の並びが目次と一致しなければならない。一致したら大項目を目次から写す
      if (toc) {
        checkedDays++;
        const tq = toc.entries.filter((e) => QA.has(e.type));
        const bq = exs.filter((e) => QA.has(e.type));
        const key = (type, name) => `${type}:${canon(normalizeName(name))}`;
        const ks = (a) => a.map((e) => key(e.type, e.questioner ?? e.name)).join(" / ");
        if (ks(tq) !== ks(bq)) {
          report.qaMismatch.push(`${file}: 目次 ${ks(tq) || "（なし）"} ／ 本文 ${ks(bq) || "（なし）"}`);
        } else {
          for (let i = 0; i < bq.length; i++) {
            checkedQa++;
            bq[i].items = tq[i].items;
            // 日程に入る前の質疑（2008年6月11日の「上田市長の発言」への質疑）は、本文に議題の宣言がないので目次の議題を使う
            if (!bq[i].agenda) bq[i].agenda = tq[i].agenda;
            if (bq[i].type === "代表質問" && !tq[i].items.length) report.noItems.push(`${file} ${bq[i].id} ${bq[i].type} ${bq[i].questioner}`);
            // 答弁者: 本文の答弁者（姓）が、目次の答弁・再質問の欄にいるか（逆も）
            const tAns = [...tq[i].answerers, ...tq[i].followups.filter((f) => f.title !== "議員")].map((a) => tocName(a.name) + (a.title ?? ""));
            const bAns = bq[i].answerers.map((a) => `${a.name ?? ""}\t${a.title}`);
            const miss = bAns.filter((b) => !tAns.some((t) => { const [n, ti] = b.split("\t"); return t.endsWith(ti) && n.startsWith(t.slice(0, t.length - ti.length)); }));
            const extra = tAns.filter((t) => !bAns.some((b) => { const [n, ti] = b.split("\t"); return t.endsWith(ti) && n.startsWith(t.slice(0, t.length - ti.length)); }));
            if (miss.length || extra.length) report.answererMismatch.push(`${file} ${bq[i].id} ${bq[i].questioner}: 本文だけ ${miss.map((x) => x.replace("\t", "")).join("、") || "-"} ／ 目次だけ ${extra.join("、") || "-"}`);
          }
        }
        // 代表質問: 市長の最初の答弁の「全体で◯項目」と大項目の数
        for (const ex of bq.filter((e) => e.type === "代表質問")) {
          const first = list.find((s) => ex.huids.includes(s.huid) && s.title === "市長" && s._as === "answer");
          const n = first ? itemCountOf(bodyOf(first)) : null;
          const head = (k) => bodyOf(first).slice(0, k).replace(/\n/g, "⏎");
          if (n == null) report.itemCountNone.push(`${file} ${ex.id} ${ex.questioner}: ${first ? head(40) : "市長の答弁がない"}`);
          else {
            checkedItems++;
            if (ex.items && n !== ex.items.length) report.itemCount.push(`${file} ${ex.id} ${ex.questioner}: 市長「${n}項目」／ 目次の大項目 ${ex.items.length}（${head(30)}）`);
          }
        }
        // ほかの種類（委員長報告、討論、説明、その他）は、目次の並びと（参考）として比べる。
        // 目次の議長・副議長の項目（閉会のあいさつなど）は○の発言なので、まとまりにならない。事務局長の諸般の報告は目次にない
        // 選ばれた議長・副議長の就任のあいさつ（目次では「〇三上洋右議員の挨拶」）も、本文では○の発言
        const chairs = new Set(list.filter((s) => s.role === "chair").map((s) => canon(s.name)));
        const to = toc.entries
          .filter((e) => !QA.has(e.type) && e.type !== "文書質問" && !/^(議長|副議長|臨時議長)$/.test(e.title ?? "") && !(e.type === "挨拶" && [...chairs].some((c) => sameName(c, e.name, canon))))
          .map((e) => ({ type: tocType(e.type), name: e.name, label: `${e.type} ${e.name ?? "（名前なし）"}${e.title && e.title !== "議員" ? e.title : ""}` }));
        const bo = exs
          .filter((e) => !QA.has(e.type) && !/^(事務局長|事務局次長)$/.test(e.answerers[0]?.title ?? ""))
          .map((e) => ({ type: e.type, name: e.questioner ?? e.answerers[0]?.name, label: `${e.type} ${e.questioner ?? `${e.answerers[0]?.name}${e.answerers[0]?.title}`}（HUID${e.id}）` }));
        // 最長共通部分列で突き合わせ、残ったものを出す（1か所の違いが後ろに波及しないように）
        const eq = (b, t) => b.type === t.type && sameName(b.name, t.name, canon);
        const L = Array.from({ length: bo.length + 1 }, () => new Array(to.length + 1).fill(0));
        for (let x = bo.length - 1; x >= 0; x--) for (let y = to.length - 1; y >= 0; y--) L[x][y] = eq(bo[x], to[y]) ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
        for (let x = 0, y = 0; x < bo.length || y < to.length; ) {
          if (x < bo.length && y < to.length && eq(bo[x], to[y])) x++, y++;
          else if (y < to.length && (x >= bo.length || L[x][y + 1] >= L[x + 1][y])) report.otherMismatch.push(`${file}: 目次だけ ${to[y++].label}`);
          else report.otherMismatch.push(`${file}: 本文だけ ${bo[x++].label}`);
        }
        for (const e of toc.entries.filter((e) => e.type === "文書質問")) report.writtenQ.push(`${file}: ${e.name}`);
      }

      for (const ex of exs) {
        if (ex.questioner && factionOf) ex.faction = factionOf(ex.term, ex.questioner, ex.date);
        if (ex.questioner && !ex.faction) report.noFaction.push(`${file} ${ex.id} ${ex.type} ${ex.questioner}`);
        if (QA.has(ex.type) && !ex.agenda) report.noAgenda.push(`${file} ${ex.id} ${ex.type} ${ex.questioner}`);
        const k = `${meeting.kind}\t${ex.type}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      out[meeting.kind].push(...exs);

      if (show) {
        console.log(`${file} ${meeting.meeting} ${meeting.label}`);
        const bySp = new Map(list.map((s) => [s.huid, s]));
        for (const ex of exs) {
          console.log(`\n[${ex.type}] id=${ex.id} 質問者=${ex.questioner ?? "-"}（${ex.faction ?? "-"}） 発言${ex.huids.length}件 ${ex.chars}字`);
          console.log(`  議題: ${ex.agenda ?? "-"}`);
          if (ex.items) console.log(`  大項目: ${ex.items.join("／")}`);
          console.log(`  答弁: ${ex.answerers.map((a) => `${a.name ?? ""}${a.title}`).join("、") || "-"}`);
          for (const h of ex.huids) {
            const s = bySp.get(h);
            console.log(`    ${s.seq} ${s.head} | ${bodyOf(s).slice(0, 50).replace(/\n/g, "⏎")}`);
          }
        }
        const outside = list.filter((s) => !seen.has(s.huid));
        console.log(`\nまとまりに入っていない発言 ${outside.length} 件（議長の進行など）`);
        for (const s of outside) console.log(`    ${s.seq} ${s.head} | ${bodyOf(s).slice(0, 60).replace(/\n/g, "⏎")}`);
        return;
      }
    }
    for (const [kind, k] of [["定例会", "k1"], ["臨時会", "k2"]]) {
      total += out[kind].length;
      await writeAtomic(path.join(OUT, `${year}-${k}.jsonl`), out[kind].map((e) => JSON.stringify(e)).join("\n") + (out[kind].length ? "\n" : ""));
    }
    console.log(`[${year}] 本会議 ${sorted.length} 日分 / まとまり 定例会 ${out.定例会.length} 件・臨時会 ${out.臨時会.length} 件`);
  }

  console.log(`\n完了: まとまり ${total} 件 / 出力 data/struct/exchanges/<年>-k1.jsonl・<年>-k2.jsonl`);
  console.log(`目次との照合: ${checkedDays} 日分。代表質問・質疑 ${checkedQa} 人分が目次と一致。市長の「全体で◯項目」を ${checkedItems} 人分で照合`);
  console.log(`会派の名簿: ${factionOf ? "pipeline/members/members.csv" : "まだない（faction は空。T3 のあと流し直す）"}`);
  console.log("\n会議の種類 × まとまりの種類:");
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.replace("\t", " × ")}: ${v}`);
  console.log("");
  const rows = [
    ["◆か◎の発言がどのまとまりにも入っていない", report.uncovered],
    ["1つの発言が2つのまとまりに入っている", report.dup],
    ["目次のない日", report.noToc],
    ["代表質問・質疑の質問者の並びが目次と違う", report.qaMismatch],
    ["代表質問・質疑に目次の大項目がない", report.noItems],
    ["市長の「全体で◯項目」と目次の大項目の数が違う", report.itemCount],
    ["代表質問・質疑に議題がない", report.noAgenda],
    ["会派が空の質問者", report.noFaction],
    ["（参考）代表質問で、市長の最初の答弁に「全体で◯項目」がない", report.itemCountNone],
    ["（参考）代表質問・質疑の答弁者が目次と違う", report.answererMismatch],
    ["（参考）委員長報告・討論・説明・その他の並びが目次と違う", report.otherMismatch],
    ["（参考）議員（◆）の答弁とみたもの（委員長報告や議員提出の議案への質疑に、委員長・提出者が答えている）", report.memberAnswer],
    ["（参考）文書質問（質問と答弁書の本文は会議録にないので、まとまりにしない）", report.writtenQ],
  ];
  for (const [label, l] of rows) {
    console.log(`${label}: ${l.length} 件`);
    for (const x of all ? l : l.slice(0, 20)) console.log(`  ${x}`);
    if (!all && l.length > 20) console.log(`  ほか ${l.length - 20} 件`);
  }
  if (report.uncovered.length || report.dup.length || report.qaMismatch.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`エラー: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
