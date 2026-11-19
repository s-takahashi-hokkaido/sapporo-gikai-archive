#!/usr/bin/env node
// 札幌市議会 会議録検索システム（sapporo.gijiroku.com）から、会議録の原本をダウンロードする。
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/01_download.mjs                      2007年〜今年の定例会・臨時会・委員会をすべて
//   node pipeline/01_download.mjs --from 2025 --to 2025 --kinds 1   お試し（2025年の定例会だけ）
//   node pipeline/01_download.mjs --dry-run            一覧だけ取って件数を数える（本文は取らない）
//
// オプション:
//   --from <年>      開始年（西暦、既定 2007）
//   --to <年>        終了年（西暦、既定 今年）
//   --kinds <列>     会議の種別。1=定例会 2=臨時会 3=委員会（既定 1,2,3）
//   --interval <ms>  リクエストの間隔（既定 1500）。相手のサーバーに負荷をかけないため、短くしない
//   --out <dir>      保存先（既定 data/raw）
//   --dry-run        一覧の取得と件数の集計だけ行う
//
// 途中で止めても、もう一度実行すれば取得済みのファイルを飛ばして続きから再開する。
// 必要なもの: Node.js 18 以上（追加のパッケージは不要）

import { mkdir, writeFile, rename, stat, appendFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://sapporo.gijiroku.com/voices/cgi/voiweb.exe";
const KIND_NAMES = { 1: "定例会", 2: "臨時会", 3: "委員会" };
const USER_AGENT = "sapporo-gikai-archive/1.0 (personal research; 1 request per 1.5s)";

// ---------- 引数 ----------
function parseArgs(argv) {
  const opts = {
    from: 2007,
    to: new Date().getFullYear(),
    kinds: [1, 2, 3],
    interval: 1500,
    out: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} の値がありません`);
      return v;
    };
    if (a === "--from") opts.from = Number(next());
    else if (a === "--to") opts.to = Number(next());
    else if (a === "--kinds") opts.kinds = next().split(",").map(Number);
    else if (a === "--interval") opts.interval = Number(next());
    else if (a === "--out") opts.out = next();
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "-h" || a === "--help") {
      console.log("使い方はファイル冒頭のコメントを参照");
      process.exit(0);
    } else throw new Error(`知らないオプション: ${a}`);
  }
  if (!Number.isInteger(opts.from) || !Number.isInteger(opts.to) || opts.from > opts.to)
    throw new Error("--from と --to は西暦の整数で、from <= to にする");
  for (const k of opts.kinds) if (!KIND_NAMES[k]) throw new Error(`--kinds は 1,2,3 のどれか: ${k}`);
  if (opts.interval < 1000) throw new Error("--interval は 1000 以上にする");
  return opts;
}

// ---------- 通信 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function fetchBytes(url, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + OPTS.interval - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= retries) throw err;
      const backoff = 5000 * 2 ** attempt;
      console.warn(`  ! ${err.message}。${backoff / 1000}秒後に再試行 (${attempt + 1}/${retries})`);
      await sleep(backoff);
    }
  }
}

// ---------- 解析 ----------
const SJIS = new TextDecoder("shift_jis");

// 一覧ページ（ACT=100）の1行:
//   令和　７年（常任）文教委員会,<A HREF="javascript:;" ... onClick="winopen('voiweb.exe?ACT=200&...&KGNO=650&FINO=4504&UNID=...');">01月15日-記録</A>
const ROW_RE =
  /\r?\n([^\r\n<]+?),<A HREF="javascript:;"[^>]*?winopen\('([^']*?FINO=(\d+)[^']*)'\);">([^<]+)<\/A>/g;

export function parseList(html, year) {
  const hit = Number((html.match(/(\d+)件の日程がヒットしました/) || [])[1] ?? 0);
  const rows = [];
  for (const m of html.matchAll(ROW_RE)) {
    const viewerPath = m[2];
    const label = m[4].trim(); // 例: 02月27日-02号 / 01月15日-記録 / 02月21日-目次
    const md = label.match(/^(\d{2})月(\d{2})日/);
    rows.push({
      year,
      fino: Number(m[3]),
      kgno: (viewerPath.match(/KGNO=(\d+)/) || [])[1] ?? null,
      unid: (viewerPath.match(/UNID=([^&]+)/) || [])[1] ?? null,
      meeting: m[1].trim().replace(/　/g, " ").replace(/\s+/g, " "),
      label,
      date: md ? `${year}-${md[1]}-${md[2]}` : null,
      viewerUrl: new URL(viewerPath, BASE).href,
    });
  }
  return { hit, rows };
}

function bodyText(html) {
  return html
    .replace(/<SCRIPT[\s\S]*?<\/SCRIPT>/gi, "")
    .replace(/<BR\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}
const countSpeakers = (text) => (text.match(/^[○◆◎]/gm) || []).length;

// ---------- ファイル ----------
async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}
async function writeAtomic(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.part`;
  await writeFile(tmp, data);
  await rename(tmp, p);
}
async function logError(entry) {
  await mkdir(OPTS.out, { recursive: true });
  await appendFile(
    path.join(OPTS.out, "errors.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
  );
}

// ---------- 本体 ----------
const here = path.dirname(fileURLToPath(import.meta.url));
let OPTS;

async function main() {
  OPTS = parseArgs(process.argv.slice(2));
  OPTS.out = path.resolve(OPTS.out ?? path.join(here, "..", "data", "raw"));
  if (typeof fetch !== "function") throw new Error("Node.js 18 以上が必要（fetch がない）");

  console.log(
    `保存先: ${OPTS.out}\n対象: ${OPTS.from}〜${OPTS.to}年 / ${OPTS.kinds.map((k) => KIND_NAMES[k]).join("・")}` +
      `${OPTS.dryRun ? "（件数だけ）" : ""}\n`,
  );

  const total = { meetings: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0, warnings: 0 };

  for (let year = OPTS.from; year <= OPTS.to; year++) {
    for (const kind of OPTS.kinds) {
      const tag = `[${year} ${KIND_NAMES[kind]}]`;
      const listUrl = `${BASE}?ACT=100&KGTP=${kind}&FYY=${year}&TYY=${year}`;
      let listBytes;
      try {
        listBytes = await fetchBytes(listUrl);
      } catch (err) {
        console.error(`${tag} 一覧の取得に失敗: ${err.message}`);
        await logError({ type: "list", year, kind, url: listUrl, error: err.message });
        total.failed++;
        continue;
      }
      await writeAtomic(path.join(OPTS.out, "lists", `${year}-k${kind}.html`), listBytes);
      const { hit, rows } = parseList(SJIS.decode(listBytes), year);
      if (rows.length !== hit) {
        console.warn(`${tag} ! ヒット ${hit} 件に対して ${rows.length} 件しか読めなかった`);
        await logError({ type: "list-mismatch", year, kind, hit, parsed: rows.length });
        total.warnings++;
      }
      console.log(`${tag} ${rows.length} 件`);
      total.meetings += rows.length;
      if (OPTS.dryRun) continue;

      const manifest = [];
      for (const [i, row] of rows.entries()) {
        const file = path.join(String(year), `${row.date ?? year}_k${kind}_${row.fino}.html`);
        const abs = path.join(OPTS.out, file);
        const bodyUrl = `${BASE}?ACT=203&KENSAKU=0&SORT=0&KTYP=1,2,3,0&KGTP=${kind}&FYY=${year}&TYY=${year}&FINO=${row.fino}`;
        const rec = { ...row, kind, kindName: KIND_NAMES[kind], file: file.split(path.sep).join("/"), bodyUrl };

        if (await exists(abs)) {
          total.skipped++;
          manifest.push({ ...rec, status: "ok" });
          continue;
        }
        try {
          const bytes = await fetchBytes(bodyUrl);
          const speakers = countSpeakers(bodyText(SJIS.decode(bytes)));
          await writeAtomic(abs, bytes);
          total.downloaded++;
          total.bytes += bytes.length;
          // 目次以外で発言者が0なら、取り方がおかしい可能性がある
          const suspicious = speakers === 0 && !/目次/.test(row.label);
          if (suspicious) {
            total.warnings++;
            await logError({ type: "no-speakers", ...rec });
          }
          manifest.push({ ...rec, status: suspicious ? "check" : "ok", bytes: bytes.length, speakers });
          console.log(
            `  ${String(i + 1).padStart(3)}/${rows.length} ${row.meeting} ${row.label}` +
              ` (${Math.round(bytes.length / 1024)}KB, 発言${speakers})${suspicious ? " ← 要確認" : ""}`,
          );
        } catch (err) {
          total.failed++;
          manifest.push({ ...rec, status: "failed", error: err.message });
          await logError({ type: "body", ...rec, error: err.message });
          console.error(`  ${String(i + 1).padStart(3)}/${rows.length} ${row.meeting} ${row.label} 失敗: ${err.message}`);
        }
      }
      await writeAtomic(
        path.join(OPTS.out, "manifest", `${year}-k${kind}.jsonl`),
        manifest.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
    }
  }

  console.log(
    `\n完了: 会議 ${total.meetings} 件 / 新規 ${total.downloaded} 件 (${(total.bytes / 1024 / 1024).toFixed(1)}MB)` +
      ` / 取得済みで飛ばした ${total.skipped} 件 / 失敗 ${total.failed} 件 / 要確認 ${total.warnings} 件`,
  );
  if (total.failed || total.warnings) console.log(`詳細は ${path.join(OPTS.out, "errors.jsonl")}。失敗分はもう一度実行すれば取り直す`);
}

// 直接実行されたときだけ動かす（テストから parseList を読み込むときは動かさない）。
// リンクをたどった実パス同士を、大文字小文字を無視して比べる（Windows のドライブ名対策）
const norm = (p) => {
  try {
    return realpathSync(path.resolve(p)).toLowerCase();
  } catch {
    return path.resolve(p).toLowerCase();
  }
};
if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  });
}
