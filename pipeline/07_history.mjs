#!/usr/bin/env node
// 工程7: 話題ごとに、工程6の任期ごとのまとめ（bundles/）を読み、20年分の経緯と現状を1つにまとめる。仕上がりの topics/<話題>/README.md になる。
// 作り方: docs/作り方.md の工程7
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/07_history.mjs --pillars --dry-run           # 送る話題と量を確かめる（1件目の中身が data/history/dry-run-request.json に出る）
//   node --env-file=.env pipeline/07_history.mjs --probe --topic 地下鉄   # 1つだけバッチを使わずに送って結果を見る（何も書かない）
//   node --env-file=.env pipeline/07_history.mjs --pillars      # 細かく分けた5分野の話題（25）
//   node --env-file=.env pipeline/07_history.mjs --others       # ほかの分野の話題（28）
//   node --env-file=.env pipeline/07_history.mjs --topic 地下鉄 # 1つの話題だけ
//   node --env-file=.env pipeline/07_history.mjs --collect <batch_id>   # 途中で止めたときに、そのバッチの結果を取って続ける
//   node pipeline/07_history.mjs --render                       # API を呼ばずに、README と目次（topics/README.md）だけ作り直す
// オプション: --model claude-opus-5-5、--fallback-model claude-opus-5-5、--effort medium、--max-tokens 64000
//
// 入力: bundles/<話題>/<任期>.json（工程6）、records/<年>.jsonl（出典のリンクと関連する話題の数え上げ）、pipeline/topics.csv、pipeline/members/factions.csv・members.csv（会派の名前の移り変わり）、pipeline/prompts/07_history_v2.md
// 出力: topics/<話題>/history.json（出典を記録の id で持つ。料金とモデルも）、topics/<話題>/README.md（読む用）、topics/README.md（目次）
// - 工程6のまとめがそろっていない話題は飛ばす（2003-2007 の任期は工程6で外したので、ここでも読まない）
// - 出典は工程6のまとめの番号を引き継がせ、URL はコードで付ける。形式チェック（入力にない番号、出典のない文が1割を超える、同じ文の繰り返し、空の欄）に落ちたら送り直す
// - 名前だけ変えた会派（factions.csv の lineage）は、移り変わりを入力の最後に渡して1つの会派として書かせる。同じ系列が2つの要素に分かれていたら形式チェックで落とす。
//   README では、いまの名前の後ろに古い名前をコードで書き添える（「民主市民連合議員会（2007〜2011年は民主党・市民連合、…）」）
// - 関連する話題（副の話題として重なる記録の多いもの）は、コードで数えて README に1行で書く（docs/作り方.md の工程4）
// - 済んだ話題は飛ばすので、何度流してもよい。作り直すときは topics/<話題>/history.json を消す

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLineages, parseCsv } from "./lib.mjs";
import { loadFlags, loadRecords, markFlags, marksOf, renderBody, sentences, termLabel } from "./06_bundle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const PROMPT_VERSION = "07_history_v2";
const TERMS = ["2007-2011", "2011-2015", "2015-2019", "2019-2023", "2023-2027"];
const OPUS = "claude-opus-5-5";
const BATCH_PRICE = {
  "claude-opus-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite1h: 4 },
  "claude-sonnet-5-5": { in: 1, out: 5, cacheRead: 0.05, cacheWrite1h: 2 },
};

const readJsonl = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const write = async (p, s) => (await mkdir(path.dirname(p), { recursive: true }), writeFile(p, s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const a = { pillars: false, others: false, topic: null, render: false, dryRun: false, probe: false, collect: null, model: OPUS, fallback: OPUS, effort: "medium", maxTokens: 64000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--pillars") a.pillars = true;
    else if (k === "--others") a.others = true;
    else if (k === "--topic") a.topic = argv[++i];
    else if (k === "--render") a.render = true;
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--probe") a.probe = true;
    else if (k === "--collect") a.collect = argv[++i];
    else if (k === "--model") a.model = argv[++i];
    else if (k === "--fallback-model") a.fallback = argv[++i];
    else if (k === "--effort") a.effort = argv[++i];
    else if (k === "--max-tokens") a.maxTokens = Number(argv[++i]);
    else throw new Error(`知らないオプション: ${k}`);
  }
  if ([a.pillars, a.others, Boolean(a.topic), a.render, Boolean(a.collect)].filter(Boolean).length !== 1) throw new Error("--pillars、--others、--topic <話題>、--render、--collect <batch_id> のどれか1つを付ける");
  return a;
}

function schema() {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["current", "history", "factions", "city_stance", "open_issues"],
    properties: {
      current: str,
      history: { type: "array", items: { type: "object", additionalProperties: false, required: ["period", "heading", "text"], properties: { period: str, heading: str, text: str } } },
      factions: { type: "array", items: { type: "object", additionalProperties: false, required: ["faction", "text"], properties: { faction: str, text: str } } },
      city_stance: { type: "array", items: str },
      open_issues: { type: "array", items: str },
    },
  };
}
const bodyTexts = (o) => [o.current, ...o.history.map((h) => h.text), ...o.factions.map((f) => f.text), ...o.city_stance, ...o.open_issues];
const allTexts = (o) => [...bodyTexts(o), ...o.history.map((h) => h.heading)];

// 会派の名前の移り変わり。入力に渡す文と、README で古い名前を書き添える文
const ym = (d) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月`;
const chainText = (chains) =>
  chains.map((c) => `- ${c.lineage}: ${c.steps.map((s) => `${s.faction}（${ym(s.from)}〜${s.to >= "2027-04-30" ? "" : ym(s.to)}）`).join(" → ")}`).join("\n");
function formerNames(chains) {
  const m = new Map();
  for (const c of chains) {
    const old = c.steps.filter((s) => s.faction !== c.lineage).map((s) => {
      const [a, b] = [s.from.slice(0, 4), s.to.slice(0, 4)];
      return `${a === b ? a : `${a}〜${b}`}年は${s.faction}`;
    });
    if (old.length) m.set(c.lineage, old.join("、"));
  }
  return m;
}

// 形式チェック。ids は入力（任期ごとのまとめ）に出てくる番号。lineageOf は会派の呼び方 → 系列（名前だけ変えた会派）
function check(out, ids, lineageOf) {
  if (typeof out?.current !== "string" || !out.current.trim()) return ["現状が空"];
  const errs = [];
  const byLineage = new Map();
  for (const f of out.factions ?? []) {
    const l = lineageOf(f.faction);
    if (l) byLineage.set(l, [...(byLineage.get(l) ?? []), f.faction]);
  }
  const split = [...byLineage].filter(([, v]) => v.length >= 2);
  if (split.length) errs.push(`同じ会派が2つ以上の要素に分かれている: ${split.map(([, v]) => v.join(" / ")).join("；")}`);
  const unknown = [...new Set(allTexts(out).flatMap(marksOf))].filter((m) => !ids.has(m));
  if (unknown.length) errs.push(`入力にない番号: ${unknown.slice(0, 5).join(" ")}${unknown.length > 5 ? ` ほか${unknown.length - 5}個` : ""}`);
  const ss = bodyTexts(out).flatMap(sentences);
  const noCite = ss.filter((s) => !marksOf(s).length);
  if (noCite.length >= 3 && noCite.length / ss.length > 0.1) errs.push(`出典のない文が多い（${noCite.length}/${ss.length}。例: ${noCite[0].slice(0, 40)}）`);
  const seen = new Map();
  for (const s of ss) {
    const k = s.replace(/\[[^\]]*\]/g, "").trim();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const rep = [...seen].filter(([k, v]) => v >= 5 && k);
  if (rep.length) errs.push(`同じ文の繰り返し（${rep[0][0].slice(0, 30)} ×${rep[0][1]}）`);
  if (!out.history.length) errs.push("20年の経緯が空");
  return errs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const topics = parseCsv(await readFile(path.join(here, "topics.csv"), "utf8"));
  const records = await loadRecords();
  const recById = new Map(records.map((r) => [r.id, r]));
  const { lineageOf, chains } = await loadLineages(path.join(here, "members"));
  const former = formerNames(chains);
  const batchLog = path.join(ROOT, "data", "history", "batches.jsonl");
  const errFile = path.join(ROOT, "topics", "errors.jsonl");
  await mkdir(path.dirname(batchLog), { recursive: true });

  let pending = null;
  if (args.collect) {
    const b = (existsSync(batchLog) ? await readJsonl(batchLog) : []).find((x) => x.batch_id === args.collect);
    if (!b) throw new Error(`控えにないバッチ: ${args.collect}`);
    Object.assign(args, { model: b.model, fallback: b.fallback, effort: b.effort, ...b.select });
    pending = b;
  }

  // 話題ごとの材料: 記録の数、任期ごとのまとめ、関連する話題
  const info = new Map(topics.map((t) => [t["話題"], { t, main: 0, years: [], terms: new Map(), relatedFrom: new Map(), relatedTo: new Map() }]));
  for (const r of records) {
    const x = info.get(r.topic);
    if (!x) continue;
    x.main++;
    x.years.push(r.date.slice(0, 4));
    for (const s of r.sub_topics ?? []) {
      x.relatedTo.set(s, (x.relatedTo.get(s) ?? 0) + 1); // この話題の記録が、副として s にもかかる
      info.get(s)?.relatedFrom.set(r.topic, (info.get(s).relatedFrom.get(r.topic) ?? 0) + 1); // s の記録として、主が r.topic のものがある
    }
  }
  const bundleFile = (name, term) => path.join(ROOT, "bundles", name, `${term}.json`);
  const histFile = (name) => path.join(ROOT, "topics", name, "history.json");
  for (const [name, x] of info) {
    const need = TERMS.filter((p) => records.some((r) => r.topic === name && r.term === p));
    x.need = need;
    for (const p of need) if (existsSync(bundleFile(name, p))) x.terms.set(p, await readJson(bundleFile(name, p)));
    x.ready = need.length > 0 && need.every((p) => x.terms.has(p));
  }

  // README と目次。工程8（08_verify.mjs）の要確認があれば、該当する文に印を付ける
  const flags = await loadFlags();
  async function render(name) {
    const x = info.get(name);
    const h = await readJson(histFile(name));
    const o = h.output;
    const link = (id) => {
      const r = recById.get(id);
      return r ? `[${r.date}](${r.url})` : `[${id}?]`;
    };
    const flag = (s) => [...(flags.get(`${name}	20年のまとめ（README）	${s}`) ?? [])].join("、") || null;
    const cite = (s) => markFlags(s, flag).replace(/(?:\[\d+-\d+(?:\s*[,、]\s*\d+-\d+)*\])+/g, (m) => `（${marksOf(m).map(link).join("、")}）`);
    const rel = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `[${k}](../${encodeURI(k)}/README.md)（${v}件）`).join("、");
    const years = x.years.sort();
    const out = [
      `# ${name}`,
      "",
      `分野: ${x.t["分野"]}。範囲: ${x.t["範囲"]}`,
      "",
      `- 記録: 主の話題として ${x.main}件（${years[0]}〜${years.at(-1)}年）`,
      `- 任期ごとのまとめ: ${x.need.map((p) => `[${termLabel(p)}](../../bundles/${encodeURI(name)}/${p}.md)`).join("、")}`,
      x.relatedFrom.size ? `- 関連: ほかの話題の記録で、この話題にもかかるもの ${rel(x.relatedFrom)}` : null,
      x.relatedTo.size ? `- 関連: この話題の記録で、ほかの話題にもかかるもの ${rel(x.relatedTo)}` : null,
      "",
      `> 会議録を AI が要約した記録（工程5）を、任期ごと（工程6）、20年分（工程7）と束ねて作った。日付は会議録へのリンク。数字や答弁を人前で使う前に、リンク先の原文を確かめる。「［要確認］」の付いた文は、照合（工程8）で数字や引用を原文や記録で確かめられなかったもの（[要確認の一覧](../要確認.md)）。「市の答弁の変化」の各項目の1文目は、続く文（出典付き）をまとめたもの。モデル ${h.model}、指示書 ${h.prompt}${h.fixes?.length ? `。人が原文で確かめて直した文 ${h.fixes.length}件（\`pipeline/fixes/07_history.jsonl\`）` : ""}。`,
      "",
      "## 現状",
      "",
      cite(o.current),
      "",
      "## 20年の経緯",
      "",
      o.history.map((d) => `### ${d.period}　${d.heading}\n\n${cite(d.text)}`).join("\n\n"),
    ].filter((l) => l !== null);
    const factionName = (f) => {
      const l = lineageOf(f.faction);
      return l ? `**${l}**${former.has(l) ? `（${former.get(l)}）` : ""}` : `**${f.faction}**`;
    };
    if (o.factions.length) out.push("", "## 会派ごとの立場", "", o.factions.map((f) => `- ${factionName(f)}: ${cite(f.text)}`).join("\n"));
    if (o.city_stance.length) out.push("", "## 市の答弁の変化", "", o.city_stance.map((s) => `- ${cite(s)}`).join("\n"));
    if (o.open_issues.length) out.push("", "## 未解決の論点", "", o.open_issues.map((s) => `- ${cite(s)}`).join("\n"));
    await write(path.join(ROOT, "topics", name, "README.md"), out.join("\n") + "\n");
  }
  async function renderIndex() {
    const lines = [
      "# 話題の一覧",
      "",
      "札幌市議会の会議録（2007〜2026年）を、話題ごとに20年分の経緯と現状を追える形にしたもの。各話題の README に、現状、20年の経緯、会派ごとの立場、市の答弁の変化、未解決の論点がある。読み方と注意は [はじめの README](../README.md)。",
      "",
      ...(() => {
        // 区の入口（areas/<区>/README.md）があるものを、札幌市の区の順に並べる
        const WARDS = ["中央区", "北区", "東区", "白石区", "厚別区", "豊平区", "清田区", "南区", "西区", "手稲区"];
        const areas = WARDS.filter((d) => existsSync(path.join(ROOT, "areas", d, "README.md")));
        const index = existsSync(path.join(ROOT, "areas", "README.md")) ? `（[10区の一覧](../areas/README.md)）` : "";
        return [
          `区から辿る${index}: ${areas.length ? areas.map((d) => `[${d}](../areas/${encodeURI(d)}/README.md)`).join("、") : "（まだ）"}。${areas.length < WARDS.length ? "ほかの区は `node pipeline/09_area.mjs --area 東区` のように作る（AI は使わない）。" : ""}`,
          "",
          "雪、子育て、交通、地域の担い手、AI・デジタルの5分野は、話題を細かく分けてある（4〜6個ずつ）。",
          "",
        ];
      })(),
      "| 分野 | 話題 | 記録 | 20年のまとめ |",
      "|---|---|---|---|",
    ];
    for (const t of topics) {
      const name = t["話題"];
      const x = info.get(name);
      const done = existsSync(histFile(name));
      lines.push(`| ${t["分野"]} | ${name} | ${x.main} | ${done ? `[README](${encodeURI(name)}/README.md)` : "（まだ）"} |`);
    }
    await write(path.join(ROOT, "topics", "README.md"), lines.join("\n") + "\n");
  }

  if (args.render) {
    let n = 0;
    for (const name of info.keys()) if (existsSync(histFile(name))) await render(name), n++;
    await renderIndex();
    console.log(`README を作り直した: ${n}話題、目次 topics/README.md`);
    return;
  }

  const targets = topics.map((t) => t["話題"]).filter((name) => (args.topic ? name === args.topic : args.pillars ? info.get(name).t["柱"] : !info.get(name).t["柱"]));
  if (args.topic && !targets.length) throw new Error(`一覧にない話題: ${args.topic}`);
  const select = { pillars: args.pillars, others: args.others, topic: args.topic };
  const name0 = args.topic ?? (args.pillars ? "細かく分けた5分野" : "ほか");
  const prompt = await readFile(path.join(here, "prompts", `${PROMPT_VERSION}.md`), "utf8");

  const inputIds = (name) => new Set([...info.get(name).terms.values()].flatMap((j) => [j.output.summary, ...j.output.developments.map((d) => d.text), ...j.output.factions.map((f) => f.text), ...j.output.city_stance, ...j.output.open_issues].flatMap(marksOf)));
  const userText = (name) => {
    const x = info.get(name);
    const blocks = x.need.map((p) => `=== 任期 ${termLabel(p)}（記録 ${x.terms.get(p).records}件） ===\n\n${renderBody(x.terms.get(p).output, null)}`);
    // API に送る入力。作ったときと同じにするため「5本柱」のまま（読む人の目に入る出力では「細かく分けた5分野」と書く）
    return [`話題: ${name}${x.t["柱"] ? `（5本柱「${x.t["柱"]}」の1つ）` : ""}`, `話題の範囲: ${x.t["範囲"]}`, `記録: ${x.main}件`, "---", blocks.join("\n\n"), "---", `=== 会派の名前の移り変わり ===\n\n${chainText(chains)}`].join("\n\n");
  };
  const params = (name, model) => ({
    model,
    max_tokens: args.maxTokens,
    system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: userText(name) }],
    output_config: { effort: args.effort, format: { type: "json_schema", schema: schema() } },
  });
  const usageCost = (model, u) => {
    const p = BATCH_PRICE[model];
    return p ? ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite1h) / 1e6 : 0;
  };

  // SDK は API を呼ぶときだけ読む（--render は npm install なしで動く）
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  for (let round = 0; round < 4; round++) {
    let batchId, jobs;
    if (pending) {
      ({ batch_id: batchId, jobs } = pending);
      pending = null;
    } else {
      const fails = new Map();
      for (const e of existsSync(errFile) ? await readJsonl(errFile) : []) if (!String(e.reason).startsWith("バッチ:")) fails.set(e.topic, (fails.get(e.topic) ?? 0) + 1); // バッチの失敗（クレジット不足など）は数えない
      const todo = targets.filter((n) => !existsSync(histFile(n)));
      const notReady = todo.filter((n) => !info.get(n).ready);
      if (notReady.length && round === 0) console.log(`[${name0}] 工程6のまとめがそろっていないので飛ばす: ${notReady.join("、")}`);
      const reqs = todo
        .filter((n) => info.get(n).ready)
        .map((n, i) => {
          const model = (fails.get(n) ?? 0) >= 2 ? args.fallback : args.model;
          return { custom_id: `t${targets.indexOf(n)}`, job: { topic: n, model }, params: params(n, model) };
        });
      if (!reqs.length) break;
      const chars = reqs.reduce((s, r) => s + r.params.messages[0].content.length, 0);
      console.log(`[${name0}] 送る ${reqs.length}件、入力 ${(chars / 1e4).toFixed(1)}万字`);
      if (args.dryRun) {
        await writeFile(path.join(ROOT, "data", "history", "dry-run-request.json"), JSON.stringify(reqs[0].params, null, 2));
        for (const r of reqs) console.log(`  ${r.job.topic}\t${r.params.messages[0].content.length}字`);
        console.log("--dry-run なので送らない");
        return;
      }
      if (args.probe) {
        const r = reqs[0];
        console.log(`1件だけ送る: ${r.job.topic}（${r.params.messages[0].content.length}字）`);
        const msg = await client.messages.stream(r.params).finalMessage();
        console.log(`stop_reason: ${msg.stop_reason}、usage: ${JSON.stringify(msg.usage)}、料金の目安（通常の値段）: $${(usageCost(r.job.model, msg.usage) * 2).toFixed(3)}`);
        const out = JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
        const bad = check(out, inputIds(r.job.topic), lineageOf);
        console.log(JSON.stringify(out, null, 2));
        console.log(bad.length ? `形式チェックに落ちた: ${bad.join("／")}` : "形式チェックに合格");
        return;
      }
      const batch = await client.messages.batches.create({ requests: reqs.map(({ custom_id, params }) => ({ custom_id, params })) });
      batchId = batch.id;
      jobs = Object.fromEntries(reqs.map((r) => [r.custom_id, r.job]));
      await appendFile(batchLog, JSON.stringify({ batch_id: batchId, created: new Date().toISOString(), select, model: args.model, fallback: args.fallback, effort: args.effort, prompt: PROMPT_VERSION, count: reqs.length, jobs }) + "\n");
      console.log(`[${name0}] 送った: ${batchId}（止めても node --env-file=.env pipeline/07_history.mjs --collect ${batchId} で続けられる）`);
    }

    for (;;) {
      const b = await client.messages.batches.retrieve(batchId);
      const n = b.request_counts;
      console.log(`[${name0}] ${new Date().toLocaleTimeString("ja-JP")} ${b.processing_status}: 処理中 ${n.processing}、成功 ${n.succeeded}、失敗 ${n.errored}`);
      if (b.processing_status === "ended") break;
      await sleep(60_000);
    }
    const errs = [];
    let sum = 0;
    for await (const r of await client.messages.batches.results(batchId)) {
      const job = jobs[r.custom_id];
      if (!job) continue;
      if (r.result.type !== "succeeded") {
        errs.push({ ...job, reason: `バッチ: ${r.result.type}` });
        continue;
      }
      const msg = r.result.message;
      const u = msg.usage;
      const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cost: usageCost(job.model, u) };
      sum += usage.cost;
      if (msg.stop_reason !== "end_turn") {
        errs.push({ ...job, reason: `stop_reason: ${msg.stop_reason}`, cost: usage.cost });
        continue;
      }
      let out;
      try {
        out = JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
      } catch {
        errs.push({ ...job, reason: "JSON として読めない", cost: usage.cost });
        continue;
      }
      const bad = check(out, inputIds(job.topic), lineageOf);
      if (bad.length) {
        errs.push({ ...job, reason: "形式チェック", detail: bad, cost: usage.cost });
        continue;
      }
      const x = info.get(job.topic);
      await write(histFile(job.topic), JSON.stringify({ topic: job.topic, terms: x.need, model: msg.model, effort: args.effort, prompt: PROMPT_VERSION, created: new Date().toISOString(), usage, output: out }, null, 2));
      await render(job.topic);
    }
    if (errs.length) await write(errFile, (existsSync(errFile) ? await readFile(errFile, "utf8") : "") + errs.map((x) => JSON.stringify({ ...x, batch_id: batchId, at: new Date().toISOString() })).join("\n") + "\n");
    console.log(`[${name0}] 受け取った。失敗 ${errs.length}件。この回の料金の目安 $${sum.toFixed(2)}`);
  }
  await renderIndex();
  const done = targets.filter((n) => existsSync(histFile(n)));
  let total = 0;
  for (const n of done) total += (await readJson(histFile(n))).usage.cost;
  console.log(`[${name0}] まとめた話題 ${done.length}/${targets.length}、料金の目安 $${total.toFixed(2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
