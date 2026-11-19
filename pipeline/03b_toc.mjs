#!/usr/bin/env node
// 工程3 T2: 会議録の目次（本会議と、予算・決算・議案審査特別委員会など）を読み、号ごとの議事の並びを作る。
// 設計: docs/工程3の設計.md の「目次 toc.jsonl（T2）」
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/03b_toc.mjs
//
// 入力:
//   data/md/<年>/*.md の目次ファイル（ラベルが「◯月◯日-目次」のもの）
//   data/struct/meetings.jsonl  号に対応する日のファイルを引く（T1 の出力）
//   data/struct/speakers.jsonl  答弁者の「姓＋役職」（例: 生野財政部長）を分けるのに、役職の一覧を使う（T1 の出力）
//
// 出力（data/struct/）:
//   toc.jsonl  1号が1行。本会議は entries に議事の並び（代表質問、討論、委員長報告、文書質問 など）、
//              特別委員会は entries に議題ごとの質疑者・答弁者の並び
//
// 毎回すべて作り直す。何度実行しても同じ結果になる。最後に検証の件数を出す。

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMd, normalizeName, toHalfDigits, termOf } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const MD = path.join(ROOT, "data", "md");
const STRUCT = path.join(ROOT, "data", "struct");

const strip = (s) => s.replace(/[\s　]/g, "");
const collapse = (s) => s.replace(/[\s　]+/g, "　").trim();
const parenDepth = (s) => (s.match(/[（(]/g) ?? []).length - (s.match(/[）)]/g) ?? []).length;
const MARK = /^[〇○◯●◆◎]/;
const LEADER = /[　 ]*…+[　 ]*([０-９\d]*)[　 ]*$/;
// 項目の「１．」（本会議）、「１　」（特別委員会）。本会議も2019年の数回分は「１　」、特別委員会も2008年の数回分は「１．」
const TOP = /^[０-９\d]+[．.　 ][　 ]*/;
// 大項目の「１．市長の政治姿勢」。2019年の数回分は「１　財政運営と市政執行」
const ITEM = /^((?:[（(][^）)]+[）)])?)([０-９\d]+)[．.　 ][　 ]*/;
const ISSUE_GO = /^第[\s　]*([０-９\d]+)[\s　]*号[\s　]*（(.+?)）$/;
const ISSUE_KAI = /^第[\s　]*([０-９\d]+)[\s　]*回$/; // 懲罰特別委員会は「第　１　回」の次の行に日付
const pad2 = (n) => String(n).padStart(2, "0");

// ---------- 行をまとめる ----------
// 空行を除き、括弧が閉じるまで次の行をつなぐ（動議の中身などが折り返されている）。行末の「……ページ」は外す。
function logicalLines(body, report, file) {
  const raw = body.split("\n").filter((l) => l.trim() !== "");
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/[\s　]+$/, "");
    const ind = line.match(/^[　 ]*/)[0].length;
    let text = line.slice(ind);
    let joined = 0;
    while (parenDepth(text) > 0 && i + 1 < raw.length && joined < 6) {
      const next = raw[i + 1].replace(/^[\s　]+|[\s　]+$/g, "");
      if (MARK.test(next) || TOP.test(next) || ISSUE_GO.test(next)) break;
      text += next;
      i++;
      joined++;
    }
    if (parenDepth(text) > 0) report.unbalanced.push(`${file}: ${text.slice(0, 60)}`);
    // 行が長くて点線のないもの（「…を求める動議）（推薦）　９」）は、閉じ括弧の後ろの数字をページとみなす
    // 人名の行も、末尾の数字はページ（「〇上田市長の提案説明152」）
    const m = text.match(LEADER) ?? text.match(/(?<=[）)])[　 ]*([０-９\d]+)$/) ?? (MARK.test(text) ? text.match(/[　 ]*([０-９\d]+)$/) : null);
    const page = m && m[1] ? Number(toHalfDigits(m[1])) : null;
    if (m) text = text.slice(0, m.index);
    // 「代表質問の続行〇伊藤牧子議員（…）」のように見出しと人名が1行になっているものは分ける
    const sm = text.match(/^((?:代表質問|討論|質問|質疑)の続行|質疑続行)[\s　]*([〇○◯●].+)$/);
    if (sm) {
      out.push({ ind, text: sm[1], page: null, leader: false });
      out.push({ ind: ind + 1, text: sm[2], page, leader: !!m });
      continue;
    }
    out.push({ ind, text, page, leader: !!m });
  }
  return out;
}

// ---------- 答弁者の「姓＋役職」を分ける ----------
// 目次の答弁者は「生野財政部長」「上　田　市　長」のように姓と役職が続いている。
// 同じ任期の会議録に出てくる発言者（speakers.jsonl）と、役職の一覧で分ける。
class NameSplitter {
  constructor(speakers, committeeNames) {
    this.byTerm = new Map(); // term → [{name, title, count}]
    this.titles = new Set(["議長", "副議長", "委員長", "副委員長", "委員", "議員"]);
    for (const s of speakers) {
      for (const [t, count] of Object.entries(s.titles)) {
        if (s.side === "official") this.titles.add(t);
        const list = this.byTerm.get(s.term) ?? [];
        list.push({ name: s.name, title: t, count });
        this.byTerm.set(s.term, list);
      }
    }
    // 委員長報告の「藤田総務委員長」「しのだ財政市民委員会副委員長」: 委員会名から役職を作る
    for (const c of committeeNames) {
      if (!c.endsWith("委員会")) continue;
      const base = c.replace(/委員会$/, "");
      for (const t of [`${base}委員長`, `${base}副委員長`, `${base}委員会委員長`, `${base}委員会副委員長`, `${base}委員`]) this.titles.add(t);
    }
    this.sorted = [...this.titles].sort((a, b) => b.length - a.length);
  }
  // 戻り値: { name, title, how }。how は term（同じ任期の発言者と一致）、dict（役職の一覧で分けた）、none（分けられない）
  split(raw, term) {
    const s = strip(raw);
    const people = this.byTerm.get(term) ?? [];
    // 1. 同じ任期の発言者と「姓＋役職」で突き合わせる。委員会の答弁者は姓だけ、本会議は氏名なので、姓で始まるかを見る。
    //    候補が複数あれば、発言の多い組み合わせを取る（本文の誤字「中垣　内財政局長」1件より「中垣内　財政局長」18件）
    let best = null;
    for (const p of people) {
      if (!s.endsWith(p.title) || s.length === p.title.length) continue;
      const sur = s.slice(0, -p.title.length);
      if (!(p.name === sur || p.name.startsWith(sur))) continue;
      if (!best || p.count > best.count || (p.count === best.count && p.title.length > best.title.length)) best = { name: sur, title: p.title, count: p.count };
    }
    if (best) return { name: best.name, title: best.title, how: "term" };
    // 2. 役職の一覧で、長く一致する役職から試す（姓は1〜6文字）。姓が同じ任期の発言者にいれば term、いなければ最初の候補を dict で返す
    let first = null;
    for (const t of this.sorted) {
      if (!s.endsWith(t) || s.length - t.length < 1 || s.length - t.length > 6) continue;
      const sur = s.slice(0, -t.length);
      if (people.some((p) => p.name === sur || p.name.startsWith(sur))) return { name: sur, title: t, how: "term" };
      first ??= { name: sur, title: t, how: "dict" };
    }
    return first ?? { name: null, title: s, how: "none" };
  }
}

// 議員の行: 「川田ただひさ議員（自由民主党）」「伴　良隆議員（会期を42日間と設定）（決定）」「山田洋聡委員」
function parseMember(s) {
  const m = strip(s).match(/^(.+?)(副委員長|委員長|副議長|議長|委員|議員)((?:[（(][^）)]*[）)])*)$/);
  if (!m) return null;
  const parens = [...m[3].matchAll(/[（(]([^）)]*)[）)]/g)].map((x) => x[1]);
  return { name: normalizeName(m[1]), title: m[2], parens };
}

// 答弁する側の行。「富田選挙管理委員長」「谷本代表監査委員」は議員の行の形にも合うので、
// 役職の一覧でより長い役職（選挙管理委員長、代表監査委員）に分けられれば、そちらを取る
function parseAnswerer(body, splitter, term, report, where) {
  const mem = parseMember(body);
  const w = splitter.split(body, term);
  if (mem && !(w.how !== "none" && w.title.length > mem.title.length)) return { name: mem.name, title: mem.title, note: mem.parens.join("") || null, mem };
  countSplit(report, w, where, body);
  return { name: w.name, title: w.title, note: null, mem: null };
}

// ---------- 本会議の目次 ----------
// 議事の進行だけの項目。日程（agenda）を変えない
const P_PROCEDURAL = /^(議事日程|本日の会議に付した事件|出席議員|欠席議員|説明員|事務局出席職員|開会宣告|開議宣告|署名議員の指名|諸般の報告|休憩宣告|再開宣告|散会宣告|延会宣告|閉会宣告|休会の決定|会議時間の延長|議長交代)/;
// 議事の途中の進行。小見出しの文脈（代表質問、答弁、討論など）を切らない
const P_RESUME = /^(休憩宣告|再開宣告|会議時間の延長|議長交代)/;
// 小見出し → 文脈
const P_SUB = [
  [/^(.*に対する)?代表質問(の続行)?(（.*）)?$/, "代表質問"],
  [/^質問の続行$/, "代表質問"],
  [/^答弁$/, "答弁"],
  [/^(再質問|再々質問|再質疑|再々質疑)$/, "再質問"],
  [/^(.*に対する)?質疑(の続行)?$/, "質疑"],
  [/意見陳述$/, "意見陳述"], // 「議案第１６号の請求代表者の意見陳述」。陳述する人は「熊谷勝子氏」
  [/^討論(の続行)?$/, "討論"],
  [/^採決$/, "採決"],
  [/^動議$/, "動議"],
  [/^発言$/, "発言"],
  [/^提案説明$/, "提案説明"],
];
// 巻末の付録（議案、意見書案、文書質問の本文、一覧表など）。ここから先は号の中身ではない
const APPENDIX = /^(議案|意見書案|決議案|意見書案・決議案|文書質問|陳情受理付託一覧表|請願受理付託一覧表|請願・陳情受理付託一覧表|議案付託表|審査結果報告書|閉会中継続審査申出一覧表|閉会中継続審査及び付託替申出書|議決事件等一覧表|.*一覧表)$/;

function newPlenaryEntry(type, agenda, extra = {}) {
  return { type, agenda, name: null, title: null, faction: null, items: [], answerers: [], followups: [], note: null, ...extra };
}

function parsePlenaryIssue(lines, ctx0) {
  const { report, splitter, term, where } = ctx0;
  const entries = [];
  let agenda = null; // いまの日程（「日程第２　議案第１号から…」）
  let ctx = null; // 小見出しの文脈
  let current = null; // いまの代表質問・質疑
  let prev = null; // 直前の行の種類
  let lastItem = null;
  const who = (raw) => splitter.split(raw, term);

  for (const l of lines) {
    const t = l.text;
    if (MARK.test(t)) {
      const body = t.slice(1);
      const s = strip(body);
      let m;
      if ((m = s.match(/^(.+?)の(?:提案説明|説明)$/))) {
        const w = who(m[1]);
        entries.push(newPlenaryEntry("提案説明", agenda, { name: w.name, title: w.title }));
        countSplit(report, w, where, m[1]);
      } else if ((m = s.match(/^(.+?)の報告(・提案説明|・説明)?$/))) {
        // 「阿知良寛美文教委員長の報告・提案説明」は、委員会提出の議案の説明を兼ねた委員長報告
        const w = who(m[1]);
        entries.push(newPlenaryEntry(/委員長$/.test(w.title) ? "委員長報告" : "報告", agenda, { name: w.name, title: w.title, note: m[2] ? m[2].slice(1) : null }));
        countSplit(report, w, where, m[1]);
      } else if ((m = s.match(/^(.+?)の(挨拶|あいさつ)$/))) {
        const w = who(m[1]);
        entries.push(newPlenaryEntry("挨拶", agenda, { name: w.name, title: w.title }));
      } else if (ctx === "意見陳述" && (m = s.match(/^(.+?)氏$/))) {
        entries.push(newPlenaryEntry("意見陳述", agenda, { name: m[1], title: "氏" }));
      } else {
        const mem = parseMember(body);
        // 答弁・再質問の後ろに、会派付きで別の議員が出てきたら、「代表質問の続行」の見出しが抜けている
        if (mem && (ctx === "答弁" || ctx === "再質問") && mem.parens.length && current && mem.name !== current.name) {
          report.missingHeading.push(`${where}: ${s}`);
          ctx = current.type;
        }
        if (mem && (ctx === "代表質問" || ctx === "質疑")) {
          current = newPlenaryEntry(ctx, agenda, { name: mem.name, title: mem.title, faction: mem.parens[0] ?? null, note: mem.parens.slice(1).join("") || null });
          entries.push(current);
          lastItem = null;
        } else if (ctx === "答弁" || ctx === "再質問") {
          const p = parseAnswerer(body, splitter, term, report, where);
          if (!current) report.orphan.push(`${where}: ${ctx} ${s}`);
          else if (ctx === "答弁") current.answerers.push({ name: p.name, title: p.title });
          else current.followups.push({ stage: ctx0.stage, name: p.name, title: p.title });
        } else if (mem && ctx === "討論") {
          entries.push(newPlenaryEntry("討論", agenda, { name: mem.name, title: mem.title, faction: mem.parens[0] ?? null }));
        } else if (mem && ctx === "動議") {
          entries.push(newPlenaryEntry("動議", agenda, { name: mem.name, title: mem.title, note: mem.parens.join("") || null }));
        } else if (ctx === "代表質問" || ctx === "質疑") {
          // 代表質問の文脈で議員でない人が出てきた（答弁の見出しが抜けているなど）
          report.unclassified.push(`${where}: ${ctx} の中の ${s}`);
        } else {
          const p = parseAnswerer(body, splitter, term, report, where);
          entries.push(newPlenaryEntry(ctx === "発言" || ctx === "提案説明" ? ctx : "その他", agenda, { name: p.name, title: p.title, note: p.note }));
        }
      }
      prev = "person";
      continue;
    }
    if (l.ind <= 1 && TOP.test(t)) {
      // 項目（「１．日程第２　議案…」「１．文書質問（田中啓介議員）」）
      const text = collapse(t.replace(TOP, ""));
      const s = strip(text);
      // 休憩・再開・議長交代などをはさんでも、代表質問の文脈は続く。ここで文脈を切ると、再開のあとに
      // 「代表質問の続行」の見出しなしで出てくる質問者（無所属・1人会派の「質問」など）が「その他」になり、
      // その人の答弁者・再質問が前の質問者に付いてしまう（2014年第1回定例会の金子やすゆき議員など。T4 で見つけた）
      // 動議・採決などの文脈は切る（再開のあとの「〇松浦　忠議員（議事進行について）」は動議ではない）
      if (!(P_RESUME.test(s) && /^(代表質問|質疑|答弁|再質問|討論)$/.test(ctx ?? ""))) ctx = null;
      let m;
      if (/^文書質問（/.test(s)) {
        // 「文書質問（伊藤理智子議員、石川佐和子議員）」「文書質問（井上ひさ子議員）（松浦　忠議員）」
        for (const n of s.slice("文書質問".length).matchAll(/([^（）、，,]+?)議員/g))
          entries.push(newPlenaryEntry("文書質問", agenda, { name: normalizeName(n[1]), title: "議員" }));
      } else if ((m = s.match(/^(.+?)の(挨拶|あいさつ)$/))) {
        const w = who(m[1]);
        entries.push(newPlenaryEntry("挨拶", agenda, { name: w.name, title: w.title }));
      } else if (!P_PROCEDURAL.test(s)) {
        agenda = text;
        current = null;
      }
      prev = l.page === null && !P_PROCEDURAL.test(s) ? "agenda" : "top";
      continue;
    }
    if (l.ind >= 2 && ITEM.test(t) && (ctx === "代表質問" || ctx === "質疑") && current) {
      // 大項目（「　　　１．市長の政治姿勢」）。会派の2人で分担したときは「（宗形）３　都市環境と防災」のように担当の姓が前に付く
      const im = t.match(ITEM);
      const no = Number(toHalfDigits(im[2]));
      if (no !== current.items.length + 1) report.itemNo.push(`${where}: ${current.name} の大項目 ${current.items.length + 1} 番めが「${no}．」`);
      lastItem = { ind: l.ind };
      current.items.push(im[1] + t.slice(im[0].length).trim());
      prev = "item";
      continue;
    }
    const s = strip(t);
    const sub = P_SUB.find(([re]) => re.test(s));
    if (sub) {
      ctx = sub[1];
      if (ctx === "再質問") ctx0.stage = s;
      prev = "sub";
      continue;
    }
    // 折り返し: 大項目の続き、日程の続き
    if (prev === "item" && lastItem && l.ind > lastItem.ind && current?.items.length) {
      current.items[current.items.length - 1] += t.trim();
      continue;
    }
    if (prev === "agenda" && l.ind >= 5) {
      agenda += t.trim();
      continue;
    }
    if (ctx === "答弁" || ctx === "再質問") {
      // 記号の抜けた答弁者（「　　上田市長」）
      const w = who(t);
      if (w.how !== "none" && current) {
        report.noMark.push(`${where}: ${s}`);
        if (ctx === "答弁") current.answerers.push({ name: w.name, title: w.title });
        else current.followups.push({ stage: ctx0.stage, name: w.name, title: w.title });
        continue;
      }
    }
    if (ctx === "代表質問" || ctx === "答弁" || ctx === "再質問" || ctx === "討論") report.unclassified.push(`${where}: ${ctx} の中の ${s.slice(0, 50)}`);
    prev = "other";
  }
  return entries;
}

// ---------- 特別委員会の目次 ----------
const C_PROCEDURAL = /^(議題|出席委員|開会宣告|開議宣告|諸報告|散会宣告|休憩宣[告言]|再開宣[告言]|閉会宣告|(副)?委員長(就任)?(挨拶|あいさつ)|議長(挨拶|あいさつ)|副委員長の互選|説明員座席表|審査日程|発言方法について|理事制の設置について|次回の委員会について)/;
// 小見出し → まとまりの種類（null は採決などで、質疑のまとまりを作らない）
const C_SUB = [
  [/^質疑続行$/, "質疑", true],
  [/^質疑$/, "質疑", false],
  [/^討論$/, "討論", false],
  [/^採決$/, null, false],
  [/^発言$/, "発言", false],
  [/^参考人発言$/, "参考人発言", false],
  [/^意見表明$/, "意見表明", false],
  [/^(提案説明|理事者の説明|理事者説明|理事者の補足説明|局長説明|補足説明)$/, "説明", false],
];

function parseCommitteeIssue(lines, ctx0) {
  const { report, splitter, term, where } = ctx0;
  const entries = [];
  let agenda = null;
  let current = null;
  let ctx = null; // 小見出しの種類。採決のときは "採決"
  let prev = null;
  const open = (type) => {
    current = { type, agenda, speakers: [], notes: [] };
    entries.push(current);
  };

  for (const l of lines) {
    const t = l.text;
    if (MARK.test(t)) {
      const mark = t[0] === "●" || t[0] === "◆" ? "●" : "〇";
      const body = t.slice(1);
      let sp;
      if (mark === "●") {
        // 質疑する側は議員の行として読む
        const mem = parseMember(body);
        if (mem) sp = { mark, name: mem.name, title: mem.title, note: mem.parens.join("") || null };
        else {
          report.qNotMember.push(`${where}: ${strip(body)}`);
          const w = splitter.split(body, term);
          sp = { mark, name: w.name, title: w.title, note: null };
        }
      } else {
        const p = parseAnswerer(body, splitter, term, report, where);
        sp = { mark, name: p.name, title: p.title, note: p.note };
      }
      if (ctx === "採決" || !current) {
        // 採決の中の発言（懲罰特別委員会の「●林　清治委員（動議）」）は「その他」にする
        open(ctx === "採決" ? "その他" : ctx ?? "質疑");
        if (!agenda) report.noAgenda.push(`${where}: ${strip(t)}`);
        ctx = current.type;
      } else if (current.type === "議題") {
        current.type = "質疑";
        report.noHeading.push(`${where}: ${agenda?.slice(0, 30)} の ${strip(t)}`);
      }
      current.speakers.push(sp);
      prev = "person";
      continue;
    }
    const s = strip(t);
    const sub = C_SUB.find(([re]) => re.test(s));
    if (sub && (l.ind >= 1 || s === "討論")) {
      const [, type, resume] = sub;
      if (type === null) ctx = "採決";
      else {
        ctx = type;
        if (resume) {
          // 休憩をはさんだ「質疑続行」は、直前の議題の質疑を続ける
          const last = [...entries].reverse().find((e) => e.type === "質疑");
          if (last && last.agenda === agenda) current = last;
          else open("質疑");
        } else if (current && current.type === "議題" && current.agenda === agenda) current.type = type;
        else open(type);
      }
      prev = "sub";
      continue;
    }
    if (l.ind <= 1 && TOP.test(t)) {
      const text = collapse(t.replace(TOP, ""));
      const ss = strip(text);
      ctx = null;
      if (!C_PROCEDURAL.test(ss)) {
        agenda = text;
        open("議題");
        prev = l.page === null ? "agenda" : "top";
      } else prev = "top";
      continue;
    }
    // 議題の折り返し（「１　議案第５号　札幌市…の一部を改正」の次の「　　する条例案」）
    if (prev === "agenda" && current && current.speakers.length === 0 && l.ind >= 2 && !/^[・（(]/.test(t)) {
      agenda += t.trim();
      current.agenda = agenda;
      prev = l.page === null ? "agenda" : "top";
      continue;
    }
    // 「（柿崎委員の質疑保留）」などの注記
    if (/^[（(].*[）)]$/.test(t.trim()) && current) {
      current.notes.push(t.trim());
      continue;
    }
    // 「１　」の抜けた議題（「　　第６款　土木費　第６項　公園緑化費中環境局関係分」）
    if (prev === "person" && l.ind <= 2 && /^(第[０-９\d]+[款項]|議案第|陳情第|請願第|平成|令和)/.test(s)) {
      report.noNumber.push(`${where}: ${s.slice(0, 50)}`);
      agenda = collapse(t);
      ctx = null;
      open("議題");
      prev = "agenda";
      continue;
    }
    if (ctx === "質疑" || ctx === "討論") report.unclassified.push(`${where}: ${ctx} の中の ${s.slice(0, 50)}`);
    prev = "other";
  }
  for (const e of entries) if (!e.notes.length) delete e.notes;
  return entries;
}

function countSplit(report, w, where, raw) {
  if (w.how === "none") report.splitNone.push(`${where}: ${strip(raw)}`);
  else if (w.how === "dict") report.splitDict.push(`${where}: ${strip(raw)} → ${w.name}／${w.title}`);
}

// ---------- 目次ファイル1つを号に分ける ----------
function splitIssues(lines, tocDate, report, file) {
  const issues = [];
  let cur = null;
  let appendix = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (l.ind >= 10 && ((m = l.text.match(ISSUE_GO)) || (m = l.text.match(ISSUE_KAI)))) {
      const no = Number(toHalfDigits(m[1]));
      let md = m[2] ? toHalfDigits(m[2]).match(/(\d+)\s*月\s*(\d+)\s*日/) : null;
      if (!m[2]) {
        // 「第　１　回」の次の行の「令和元年（2019年）５月27日」
        const d = toHalfDigits(lines[i + 1]?.text ?? "").match(/（(\d{4})年）\s*(\d+)\s*月\s*(\d+)\s*日/);
        if (d) {
          md = [null, d[2], d[3]];
          i++;
        }
      }
      let date = null;
      if (md) {
        let y = Number(tocDate.slice(0, 4));
        const mm = Number(md[1]);
        if (mm < Number(tocDate.slice(5, 7))) y++; // 年をまたぐ会期
        date = `${y}-${pad2(mm)}-${pad2(Number(md[2]))}`;
      } else report.noDate.push(`${file}: ${l.text}`);
      cur = { no, date, lines: [] };
      issues.push(cur);
      appendix = false;
      continue;
    }
    if (!cur || appendix) continue;
    if (l.ind <= 1 && l.leader && !TOP.test(l.text) && APPENDIX.test(strip(l.text))) {
      appendix = true;
      continue;
    }
    cur.lines.push(l);
  }
  return issues;
}

// ---------- 本体 ----------
async function writeAtomic(p, text) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(`${p}.part`, text);
  await rename(`${p}.part`, p);
}

async function readJsonl(p) {
  try {
    return (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`${path.relative(ROOT, p)} がない。先に node pipeline/03a_speeches.mjs を流す`);
    throw err;
  }
}

async function main() {
  const meetings = await readJsonl(path.join(STRUCT, "meetings.jsonl"));
  const speakers = await readJsonl(path.join(STRUCT, "speakers.jsonl"));
  const splitter = new NameSplitter(speakers, new Set(meetings.map((m) => m.committee).filter(Boolean)));

  // 日のファイルを「会議名＋号」で引く
  const dayByKey = new Map();
  for (const m of meetings) if (m.issue && /^\d+号$/.test(m.issue)) {
    const k = `${m.meeting}\t${m.issue}`;
    dayByKey.set(k, [...(dayByKey.get(k) ?? []), m]);
  }
  const tocs = meetings.filter((m) => m.issue === "目次").sort((a, b) => a.file.localeCompare(b.file));

  const report = {
    noIssue: [], issueNo: [], noDate: [], noDay: [], dateMismatch: [], dayNotInToc: [], unbalanced: [], unclassified: [],
    noFaction: [], noItems: [], noAnswerers: [], itemNo: [], orphan: [], noMark: [], missingHeading: [], noNumber: [], noAgenda: [], noHeading: [],
    qNotMember: [], splitNone: [], splitDict: [],
  };
  const out = [];
  const usedDays = new Set();
  const typeCount = {};
  const factionCount = {};
  let plenaryIssues = 0, committeeIssues = 0, cSpeakers = 0;

  for (const toc of tocs) {
    const { meta, body } = await readMd(path.join(MD, toc.file));
    const lines = logicalLines(body, report, toc.file);
    const issues = splitIssues(lines, meta.date, report, toc.file);
    if (!issues.length) report.noIssue.push(toc.file);
    issues.forEach((iss, i) => { if (iss.no !== i + 1) report.issueNo.push(`${toc.file}: ${i + 1} 番めの号が第${iss.no}号`); });
    const plenary = toc.kind !== "委員会";

    for (const iss of issues) {
      const issue = `${pad2(iss.no)}号`;
      const cands = dayByKey.get(`${toc.meeting}\t${issue}`) ?? [];
      const day = cands.find((d) => d.date === iss.date) ?? (cands.length === 1 ? cands[0] : null);
      if (!day) report.noDay.push(`${toc.file}: 第${iss.no}号（${iss.date}）`);
      else {
        usedDays.add(day.file);
        if (day.date !== iss.date) report.dateMismatch.push(`${toc.file}: 第${iss.no}号 目次 ${iss.date} / 会議録 ${day.date}`);
      }
      const date = day?.date ?? iss.date;
      const term = day?.term ?? termOf(date);
      const where = `${toc.file} 第${iss.no}号`;
      const ctx0 = { report, splitter, term, where, stage: null };
      const entries = plenary ? parsePlenaryIssue(iss.lines, ctx0) : parseCommitteeIssue(iss.lines, ctx0);

      for (const e of entries) {
        typeCount[`${plenary ? "本会議" : "特別委員会"}:${e.type}`] = (typeCount[`${plenary ? "本会議" : "特別委員会"}:${e.type}`] ?? 0) + 1;
        if (plenary && e.type === "代表質問") {
          if (!e.faction) report.noFaction.push(`${where}: ${e.name}`);
          else factionCount[e.faction] = (factionCount[e.faction] ?? 0) + 1;
          if (!e.items.length) report.noItems.push(`${where}: ${e.name}`);
          if (!e.answerers.length) report.noAnswerers.push(`${where}: ${e.name}`);
        }
        if (!plenary) cSpeakers += e.speakers.length;
      }
      if (plenary) plenaryIssues++;
      else committeeIssues++;

      out.push({
        toc_file: toc.file, file: day?.file ?? null, kind: toc.kind, meeting: toc.meeting,
        session: day?.session ?? toc.session, term, committee: toc.committee, committee_type: toc.committeeType,
        issue, date, entries,
      });
    }
  }

  // 目次のある会議で、目次に出てこない号
  const tocMeetings = new Set(tocs.map((t) => t.meeting));
  for (const m of meetings) if (tocMeetings.has(m.meeting) && /^\d+号$/.test(m.issue ?? "") && !usedDays.has(m.file)) report.dayNotInToc.push(`${m.file}: ${m.meeting} ${m.issue}`);

  await writeAtomic(path.join(STRUCT, "toc.jsonl"), out.map((o) => JSON.stringify(o)).join("\n") + "\n");

  console.log(`完了: 目次 ${tocs.length} 件 / 号 ${out.length} 件（本会議 ${plenaryIssues}、特別委員会 ${committeeIssues}）/ 出力 data/struct/toc.jsonl`);
  const byType = (side) => Object.entries(typeCount).filter(([k]) => k.startsWith(`${side}:`)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.split(":")[1]} ${v}`).join("、");
  console.log(`本会議の議事: ${byType("本会議")}`);
  console.log(`特別委員会の議題ごとのまとまり: ${byType("特別委員会")} / 発言者の行 ${cSpeakers}`);
  console.log(`代表質問の会派（目次の略称）: ${Object.entries(factionCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("、")}`);
  console.log("");
  const rows = [
    ["号を1つも読めない目次", report.noIssue, true],
    ["号の番号が1から続いていない", report.issueNo, true],
    ["号の日付を読めない", report.noDate, true],
    ["号に対応する会議録が見つからない", report.noDay, true],
    ["号の日付が会議録と違う", report.dateMismatch, true],
    ["目次のある会議で、目次に出てこない号", report.dayNotInToc, true],
    ["括弧が閉じない行", report.unbalanced, true],
    ["読み取れない行（質疑・答弁などの中）", report.unclassified, true],
    ["代表質問に会派がない", report.noFaction, true],
    ["代表質問に大項目がない", report.noItems, true],
    ["代表質問に答弁者がない", report.noAnswerers, true],
    ["大項目の番号が1から続いていない", report.itemNo, true],
    ["答弁・再質問がどの質問にも属さない", report.orphan, true],
    ["記号の抜けた答弁者（役職で読んだ）", report.noMark, false],
    ["答弁・再質問のあとに「代表質問の続行」の見出しがなく、会派付きの議員が出てくる（代表質問として読んだ）", report.missingHeading, false],
    ["特別委員会で、「１　」の抜けた議題（議題として読んだ）", report.noNumber, false],
    ["特別委員会で、議題より前の質疑者", report.noAgenda, false],
    ["特別委員会で、「質疑」の見出しがない議題の質疑者", report.noHeading, false],
    ["特別委員会で、●なのに議員・委員でない", report.qNotMember, false],
    ["答弁者の姓と役職を分けられない", report.splitNone, false],
    ["答弁者が同じ任期の発言者に見つからず、役職の一覧で分けた", report.splitDict, false],
  ];
  for (const [label, list, must] of rows) {
    console.log(`${must ? "" : "（参考）"}${label}: ${list.length} 件`);
    for (const l of list.slice(0, 20)) console.log(`  ${l}`);
    if (list.length > 20) console.log(`  ほか ${list.length - 20} 件`);
  }
  if (rows.some(([, list, must]) => must && list.length)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
