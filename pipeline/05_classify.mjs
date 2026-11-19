#!/usr/bin/env node
// 工程5: まとまり1件ずつ API で読み、項目ごとの記録（話題、地域、質問と答弁の要旨、数字、約束）を作る。
// 最初の版は工程4の試行（--trial）に使う。作り方: docs/作り方.md の工程4・5
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/05_classify.mjs --trial --dry-run   # API を呼ばずに、送る内容と量だけ確かめる
//   node pipeline/05_classify.mjs --trial --probe [まとまりの id]  # 1件だけ（id がなければいちばん短いもの）をバッチを使わずに送り、結果を画面に出す（何も書かない。キーと形式の確認用）
//   node pipeline/05_classify.mjs --trial             # 試行: 新旧の年から抜いた300件を分類する（工程4）
//   node pipeline/05_classify.mjs --year 2024         # 本番: その年のまとまりを分類する（工程5。records/ に書く）
//   node pipeline/05_classify.mjs --collect <batch_id> [--trial | --year 2024]  # 途中で止めたときに結果だけ取る
//   node pipeline/05_classify.mjs --recheck [--trial | --year 2024]  # 形式チェックに落ちたものを、送り直さずに今のチェックで確かめ直す（API を呼ばない）
// オプション: --n 300（試行の件数）、--model claude-haiku-5-5、--effort medium、--max-tokens 64000（Haiku は考える過程が長く、代表質問で 16000 では切れる。試行で31/40件）、--tag v3（試行の出力のフォルダ名に付ける名札。指示書を変えて同じモデルで試し直すとき）
//
// API の認証は SDK の既定（環境変数 ANTHROPIC_API_KEY など）。キーをファイルに置くなら、
// .gitignore で除外されている .env に書き、node --env-file=.env pipeline/05_classify.mjs ... で流す
//
// 入力: data/struct/exchanges/<年>-k1,k2,k3.jsonl、data/struct/speeches/<年>.jsonl（工程3）、
//       pipeline/topics.csv（話題の一覧）、pipeline/prompts/05_classify_v1.md（指示書）
// 出力: 試行は data/topics/trial/<モデル>/（--effort が medium でなければ <モデル>-<effort>/）records.jsonl と empty.jsonl、errors.jsonl。本番は records/<年>.jsonl と records/errors/<年>.jsonl
//       送ったバッチの控えは data/classify/batches.jsonl
// - Message Batches で送る（料金が半分。たいてい1時間以内に終わる）。終わるまで1分おきに様子を見る
// - 記録済みのまとまりは飛ばすので、何度流してもよい。形式チェックに落ちたものは errors に書き、次に流したときに送り直す
// - 指示書と話題の一覧は system に置き、プロンプトキャッシュで2件目以降を安くする

import Anthropic from "@anthropic-ai/sdk";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const STRUCT = path.join(ROOT, "data", "struct");
const PROMPT_VERSION = "05_classify_v3";
const AREAS = ["全市", "中央区", "北区", "東区", "白石区", "厚別区", "豊平区", "清田区", "南区", "西区", "手稲区"];
// バッチの料金（100万トークンあたりのドル。通常の半額）。見積もりの表示にだけ使う
const BATCH_PRICE = {
  "claude-opus-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite1h: 4 },
  "claude-sonnet-5-5": { in: 1, out: 5, cacheRead: 0.05, cacheWrite1h: 2 },
  "claude-haiku-5-5": { in: 0.05, out: 0.25, cacheRead: 0.005, cacheWrite1h: 0.1 }, // 1回の入力が10万トークンまでの料金
};

const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const a = { trial: false, dryRun: false, probe: false, recheck: false, year: null, collect: null, n: 300, model: "claude-haiku-5-5", effort: "medium", maxTokens: 64000, tag: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--trial") a.trial = true;
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--recheck") a.recheck = true;
    else if (k === "--probe") a.probe = /^\d+$/.test(argv[i + 1] ?? "") ? Number(argv[++i]) : true;
    else if (k === "--year") a.year = Number(argv[++i]);
    else if (k === "--collect") a.collect = argv[++i];
    else if (k === "--n") a.n = Number(argv[++i]);
    else if (k === "--model") a.model = argv[++i];
    else if (k === "--effort") a.effort = argv[++i];
    else if (k === "--max-tokens") a.maxTokens = Number(argv[++i]);
    else if (k === "--tag") a.tag = argv[++i];
    else throw new Error(`知らないオプション: ${k}`);
  }
  if (a.trial === Boolean(a.year)) throw new Error("--trial か --year <年> のどちらか1つを付ける");
  return a;
}

// 再現できる乱数（試行の抜き取りを毎回同じにする）
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample(arr, n, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function loadExchanges(years) {
  const out = [];
  for (const y of years)
    for (const k of ["k1", "k2", "k3"]) {
      const p = path.join(STRUCT, "exchanges", `${y}-${k}.jsonl`);
      if (existsSync(p)) out.push(...(await readJsonl(p)));
    }
  return out.filter((e) => e.type !== "その他");
}

// 試行: 古い4年（2007〜2010）と新しい4年（2023〜2026）から、種類ごとに決まった数を抜く
async function pickTrial(n) {
  const rand = rng(20261117);
  const strata = [
    ["代表質問", (e) => e.type === "代表質問", 20],
    ["本会議のほか", (e) => e.kind !== "委員会" && e.type !== "代表質問", 10],
    ["常任委員会の質疑", (e) => e.committee_type === "常任" && e.type === "質疑", 40],
    ["予算特別委員会の質疑", (e) => e.committee_type === "予算特別" && e.type === "質疑", 25],
    ["決算特別委員会の質疑", (e) => e.committee_type === "決算特別" && e.type === "質疑", 25],
    ["調査・議案審査特別委員会の質疑", (e) => /調査特別|議案審査特別/.test(e.committee_type ?? "") && e.type === "質疑", 15],
    ["委員会の説明・討論", (e) => e.kind === "委員会" && e.type !== "質疑", 15],
  ];
  const scale = n / 300;
  const picked = [];
  for (const years of [[2007, 2008, 2009, 2010], [2023, 2024, 2025, 2026]]) {
    const exs = await loadExchanges(years);
    for (const [, f, k] of strata) picked.push(...sample(exs.filter(f), Math.round(k * scale), rand));
  }
  return picked;
}

async function loadSpeeches(years) {
  const m = new Map();
  for (const y of years) for (const s of await readJsonl(path.join(STRUCT, "speeches", `${y}.jsonl`))) m.set(s.huid, s);
  return m;
}

function userText(e, sp) {
  const head = [
    `種類: ${e.type}`,
    `会議: ${e.committee ?? e.session ?? e.kind}（${e.date}）`,
    e.agenda ? `議題: ${e.agenda}` : null,
    e.questioner ? `質問者: ${e.questioner}（${e.faction ?? "会派不明"}）` : null,
    e.items?.length ? `目次の大項目: ${e.items.map((t, i) => `${i + 1}. ${t}`).join(" / ")}` : null,
    e.answerers?.length ? `答弁者: ${e.answerers.map((a) => `${a.title} ${a.name}`).join("、")}` : null,
  ].filter(Boolean);
  const body = e.huids.map((h) => `[HUID ${h}] ${sp.get(h)?.text ?? "（発言が見つからない）"}`);
  return `${head.join("\n")}\n\n---\n\n${body.join("\n\n")}`;
}

function schema(topicNames) {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "topic", "sub_topics", "topic_alternative", "areas", "places", "question", "answer", "numbers", "commitments", "huids"],
          properties: {
            title: str,
            topic: { type: "string", enum: topicNames },
            sub_topics: { type: "array", items: { type: "string", enum: topicNames } },
            topic_alternative: { type: "string", enum: ["なし", ...topicNames] },
            areas: { type: "array", items: { type: "string", enum: AREAS } },
            places: { type: "array", items: str },
            question: str,
            answer: str,
            numbers: {
              type: "array",
              items: { type: "object", additionalProperties: false, required: ["value", "meaning", "huid"], properties: { value: str, meaning: str, huid: { type: "integer" } } },
            },
            commitments: {
              type: "array",
              items: { type: "object", additionalProperties: false, required: ["quote", "speaker", "huid"], properties: { quote: str, speaker: str, huid: { type: "integer" } } },
            },
            huids: { type: "array", items: { type: "integer" } },
          },
        },
      },
    },
  };
}

// 形式チェック。落ちた理由の配列を返す（空なら合格）。直してよいものはここで直す（out を書き換える）
// - 地域が空なら「全市」にする
// - 「全市」と区の両方があるのはよい（全市の話の中で特定の区に具体的に触れているもの。試行で6件あり、北区で絞ったときに拾えたほうがよいので認めた）
function check(out, e, topicNames) {
  const errs = [];
  const own = new Set(e.huids);
  if (!Array.isArray(out?.items)) return ["items がない"];
  // 項目が空なのは、手続きだけのまとまり（指示書の「項目の分け方」）。合格として扱い、empty に記録する
  out.items.forEach((it, i) => {
    const at = `項目${i + 1}`;
    if (it.areas.length === 0) it.areas = ["全市"];
    if (!topicNames.includes(it.topic)) errs.push(`${at}: 主の話題が一覧にない（${it.topic}）`);
    if (it.sub_topics.length > 2) errs.push(`${at}: 副の話題が3つ以上`);
    if (it.sub_topics.includes(it.topic)) errs.push(`${at}: 副の話題に主の話題が入っている`);
    if (it.huids.length === 0) errs.push(`${at}: 発言の番号がない`);
    for (const h of [...it.huids, ...it.numbers.map((x) => x.huid), ...it.commitments.map((x) => x.huid)])
      if (!own.has(h)) errs.push(`${at}: このまとまりにない発言の番号（${h}）`);
    if (!it.question.trim() || !it.answer.trim()) errs.push(`${at}: 要旨が空`);
  });
  return errs;
}

// 記録の1行（1つの項目）。まとまりの情報を前に付ける
function recordLines(out, e, model, prompt) {
  return out.items.map((it, i) =>
    JSON.stringify({
      id: `${e.id}-${i + 1}`,
      exchange: e.id,
      date: e.date,
      term: e.term,
      kind: e.kind,
      committee: e.committee,
      committee_type: e.committee_type,
      type: e.type,
      agenda: e.agenda,
      questioner: e.questioner,
      faction: e.faction,
      ...it,
      url: e.url.replace(/HUID=\d+/, `HUID=${it.huids[0]}`),
      model,
      prompt,
    }),
  );
}
const emptyRow = (e, model, prompt) => ({ exchange: e.id, date: e.date, type: e.type, committee: e.committee, agenda: e.agenda, model, prompt });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const topics = parseCsv(await readFile(path.join(here, "topics.csv"), "utf8"));
  const topicNames = topics.map((t) => t["話題"]);
  const prompt = (await readFile(path.join(here, "prompts", `${PROMPT_VERSION}.md`), "utf8"))
    .replace("{{TOPICS}}", topics.map((t) => `- ${t["話題"]}｜${t["分野"]}｜${t["範囲"]}｜${t["分け目"] || "—"}`).join("\n"))
    .replace("{{AREAS}}", AREAS.join("、"));

  // 試行はモデルごとに分けて書く（04c_compare_models.mjs で比べる）
  const outDir = args.trial ? path.join(ROOT, "data", "topics", "trial", [args.model, args.effort === "medium" ? null : args.effort, args.tag].filter(Boolean).join("-")) : path.join(ROOT, "records");
  const outFile = path.join(outDir, args.trial ? "records.jsonl" : `${args.year}.jsonl`);
  const errFile = args.trial ? path.join(outDir, "errors.jsonl") : path.join(outDir, "errors", `${args.year}.jsonl`);
  const emptyFile = args.trial ? path.join(outDir, "empty.jsonl") : path.join(outDir, "empty", `${args.year}.jsonl`);
  await mkdir(path.dirname(errFile), { recursive: true });
  await mkdir(path.dirname(emptyFile), { recursive: true });

  const targets = args.trial ? await pickTrial(args.n) : await loadExchanges([args.year]);
  const byId = new Map(targets.map((e) => [`ex-${e.id}`, e]));
  const done = new Set([
    ...(existsSync(outFile) ? (await readJsonl(outFile)).map((r) => r.exchange) : []),
    ...(existsSync(emptyFile) ? (await readJsonl(emptyFile)).map((r) => r.exchange) : []),
  ]);

  // --recheck: 形式チェックに落ちたものを、送り直さずに今の check() で確かめ直す（チェックの決まりを直したとき）
  if (args.recheck) {
    const all = existsSync(errFile) ? await readJsonl(errFile) : [];
    const exs = new Map(targets.map((e) => [e.id, e]));
    const keep = [], lines = [], empties = [];
    for (const x of all) {
      const e = exs.get(x.exchange);
      if (x.reason !== "形式チェック" || !x.output || !e || done.has(e.id)) {
        if (!done.has(x.exchange)) keep.push(x);
        continue;
      }
      const bad = check(x.output, e, topicNames);
      if (bad.length) {
        keep.push({ ...x, detail: bad });
        continue;
      }
      const model = x.model ?? args.model, prompt = x.prompt ?? PROMPT_VERSION;
      if (x.output.items.length === 0) empties.push(emptyRow(e, model, prompt));
      lines.push(...recordLines(x.output, e, model, prompt));
      done.add(e.id);
    }
    if (lines.length) await appendFile(outFile, lines.join("\n") + "\n");
    if (empties.length) await appendFile(emptyFile, empties.map((x) => JSON.stringify(x)).join("\n") + "\n");
    await writeFile(errFile, keep.map((x) => JSON.stringify(x)).join("\n") + (keep.length ? "\n" : ""));
    console.log(`確かめ直した: ${all.length}件 → 記録に移した項目 ${lines.length}件、残った失敗 ${keep.length}件`);
    return;
  }

  if (!args.collect) {
    const todo = targets.filter((e) => !done.has(e.id));
    const sp = await loadSpeeches([...new Set(todo.map((e) => e.date.slice(0, 4)))]);
    const requests = todo.map((e) => ({
      custom_id: `ex-${e.id}`,
      params: {
        model: args.model,
        max_tokens: args.maxTokens,
        system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: userText(e, sp) }],
        output_config: { effort: args.effort, format: { type: "json_schema", schema: schema(topicNames) } },
      },
    }));
    const chars = requests.reduce((a, r) => a + r.params.messages[0].content.length, 0);
    console.log(`対象 ${targets.length}件、記録済み ${done.size}件、送る ${requests.length}件（本文 ${(chars / 1e4).toFixed(1)}万字、指示書 ${prompt.length}字）`);
    if (args.dryRun) {
      const dryDir = args.trial ? outDir : path.join(ROOT, "data", "classify"); // 本番の dry-run は Git で管理する records/ に書かない
      const p = path.join(dryDir, "dry-run-request.json");
      await mkdir(dryDir, { recursive: true });
      await writeFile(p, JSON.stringify(requests[0], null, 2));
      await writeFile(
        path.join(dryDir, "dry-run-targets.jsonl"),
        todo.map((e) => JSON.stringify({ id: e.id, date: e.date, kind: e.kind, committee: e.committee, type: e.type, questioner: e.questioner, chars: e.chars, agenda: e.agenda })).join("\n") + "\n",
      );
      const kinds = {};
      todo.forEach((e) => (kinds[`${e.date.slice(0, 4) <= "2010" ? "旧" : "新"} ${e.committee_type ?? e.kind} ${e.type}`] = (kinds[`${e.date.slice(0, 4) <= "2010" ? "旧" : "新"} ${e.committee_type ?? e.kind} ${e.type}`] ?? 0) + 1));
      console.log(kinds);
      console.log(`--dry-run なので送らない。1件目の中身: ${path.relative(ROOT, p)}`);
      return;
    }
    if (requests.length === 0) return console.log("送るものがない");
    if (args.probe) {
      const r =
        args.probe === true
          ? requests.reduce((a, b) => (b.params.messages[0].content.length < a.params.messages[0].content.length ? b : a))
          : requests.find((x) => x.custom_id === `ex-${args.probe}`);
      if (!r) throw new Error(`試行の対象にないまとまり: ${args.probe}`);
      const e = byId.get(r.custom_id);
      console.log(`1件だけ送る: ${r.custom_id}（${e.date} ${e.committee ?? e.kind} ${e.type}、本文 ${r.params.messages[0].content.length}字）`);
      const msg = await new Anthropic().messages.create(r.params);
      console.log(`stop_reason: ${msg.stop_reason}、model: ${msg.model}`);
      console.log(`usage: ${JSON.stringify(msg.usage)}`);
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const out = JSON.parse(text);
      console.log(JSON.stringify(out, null, 2));
      const bad = check(out, e, topicNames);
      console.log(bad.length ? `形式チェックに落ちた: ${bad.join("／")}` : "形式チェックに合格");
      return;
    }
    const client = new Anthropic();
    const batch = await client.messages.batches.create({ requests });
    await mkdir(path.join(ROOT, "data", "classify"), { recursive: true });
    await appendFile(
      path.join(ROOT, "data", "classify", "batches.jsonl"),
      JSON.stringify({ batch_id: batch.id, created: new Date().toISOString(), mode: args.trial ? "trial" : `year-${args.year}`, count: requests.length, model: args.model, effort: args.effort, prompt: PROMPT_VERSION }) + "\n",
    );
    console.log(`送った: ${batch.id}（止めても、node pipeline/05_classify.mjs --collect ${batch.id} ${args.trial ? "--trial" : `--year ${args.year}`} で結果を取れる）`);
    args.collect = batch.id;
  }

  const client = new Anthropic();
  let batch;
  for (;;) {
    batch = await client.messages.batches.retrieve(args.collect);
    const c = batch.request_counts;
    console.log(`${new Date().toLocaleTimeString("ja-JP")} ${batch.processing_status}: 処理中 ${c.processing}、成功 ${c.succeeded}、失敗 ${c.errored}`);
    if (batch.processing_status === "ended") break;
    await sleep(60_000);
  }

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let ok = 0;
  const errs = [];
  const lines = [];
  const empties = [];
  for await (const r of await client.messages.batches.results(args.collect)) {
    const e = byId.get(r.custom_id);
    if (!e) continue; // 別のモードで送ったもの
    if (done.has(e.id)) continue;
    if (r.result.type !== "succeeded") {
      errs.push({ exchange: e.id, reason: `バッチ: ${r.result.type}`, detail: r.result.type === "errored" ? r.result.error : null });
      continue;
    }
    const msg = r.result.message;
    const u = msg.usage;
    usage.input += u.input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    if (msg.stop_reason !== "end_turn") {
      errs.push({ exchange: e.id, reason: `stop_reason: ${msg.stop_reason}`, detail: msg.stop_details ?? null });
      continue;
    }
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    let out;
    try {
      out = JSON.parse(text);
    } catch {
      errs.push({ exchange: e.id, reason: "JSON として読めない", detail: text.slice(0, 200) });
      continue;
    }
    const bad = check(out, e, topicNames);
    if (bad.length) {
      errs.push({ exchange: e.id, reason: "形式チェック", detail: bad, output: out, model: msg.model, prompt: PROMPT_VERSION });
      continue;
    }
    if (out.items.length === 0) empties.push(emptyRow(e, msg.model, PROMPT_VERSION));
    lines.push(...recordLines(out, e, msg.model, PROMPT_VERSION));
    ok++;
  }
  if (lines.length) await appendFile(outFile, lines.join("\n") + "\n");
  if (empties.length) await appendFile(emptyFile, empties.map((x) => JSON.stringify(x)).join("\n") + "\n");
  // 失敗の控えは、送り直して記録できたものを消し、今回の失敗を足して書き直す
  const recorded = new Set([...lines.map((l) => JSON.parse(l).exchange), ...empties.map((x) => x.exchange)]);
  const prevErrs = (existsSync(errFile) ? await readJsonl(errFile) : []).filter((x) => !recorded.has(x.exchange) && !errs.some((y) => y.exchange === x.exchange));
  const allErrs = [...prevErrs, ...errs.map((x) => ({ ...x, batch_id: args.collect, at: new Date().toISOString() }))];
  await writeFile(errFile, allErrs.map((x) => JSON.stringify(x)).join("\n") + (allErrs.length ? "\n" : ""));

  console.log(`記録した: まとまり ${ok}件 → 項目 ${lines.length}件（${path.relative(ROOT, outFile)}）。うち項目なし（手続きだけ）${empties.length}件（${path.relative(ROOT, emptyFile)}）`);
  console.log(`失敗: ${errs.length}件${errs.length ? `（${path.relative(ROOT, errFile)}。もう一度流せば送り直す）` : ""}`);
  const price = BATCH_PRICE[args.model];
  console.log(`トークン: 入力 ${usage.input}、キャッシュ読み ${usage.cacheRead}、キャッシュ書き ${usage.cacheWrite}、出力 ${usage.output}`);
  if (price && ok) {
    const cost = (usage.input * price.in + usage.output * price.out + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite1h) / 1e6;
    console.log(`料金の目安: $${cost.toFixed(2)}（1件あたり $${(cost / (ok + errs.length)).toFixed(3)}）`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
