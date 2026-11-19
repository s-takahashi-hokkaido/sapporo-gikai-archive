#!/usr/bin/env node
// 工程7の手直し: 人が原文で確かめて直した文を、20年のまとめ（topics/<話題>/history.json）に当てる。API は使わない。
// 作り方: docs/照合と手直し.md の「人の手直し」
//
// 使い方（リポジトリの直下で実行）:
//   node pipeline/07b_fix.mjs                  # pipeline/fixes/07_history.jsonl の直しを当てる
//   node pipeline/07_history.mjs --render      # README を作り直す
//   node pipeline/08_verify.mjs                # 照合し直す
//
// 直しは pipeline/fixes/07_history.jsonl に1行1件で書く（topic、before、after、reason、date）。before は、その話題のまとめの中で1か所だけに出る文字列にする。
// - 何度流してもよい。after がもうあれば飛ばす
// - 工程7を流し直すと history.json は作り直され、直しは消える。流し直したあとにもう一度これを流す。文が変わって before が見つからないものは「見つからない」と出るので、原文で確かめ直す
// - 当てた直しは history.json の fixes に残る（README の頭に件数が出る）

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const fixes = (await readFile(path.join(here, "fixes", "07_history.jsonl"), "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

// まとめの中の文字列を全部たどり、before を after に替える。替えた数を返す
function replaceIn(o, before, after) {
  let n = 0;
  const walk = (v) => {
    if (typeof v === "string") {
      const k = v.split(before).length - 1;
      n += k;
      return k ? v.split(before).join(after) : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, walk(x)]));
    return v;
  };
  return { out: walk(o), n };
}
const count = (o, s) => JSON.stringify(o).split(JSON.stringify(s).slice(1, -1)).length - 1;

const res = { applied: 0, already: 0, missing: [], ambiguous: [] };
const byTopic = Map.groupBy(fixes, (f) => f.topic);
for (const [topic, fs] of byTopic) {
  const file = path.join(ROOT, "topics", topic, "history.json");
  if (!existsSync(file)) {
    res.missing.push(...fs.map((f) => `${topic}: まとめがない`));
    continue;
  }
  const h = JSON.parse(await readFile(file, "utf8"));
  h.fixes ??= [];
  let changed = false;
  for (const f of fs) {
    if (count(h.output, f.after)) {
      // after が before を含む（末尾に番号を足すなど）ときも、after があれば当て済み
      res.already++;
      continue;
    }
    const nb = count(h.output, f.before);
    if (nb === 0) {
      res.missing.push(`${topic}: ${f.before.slice(0, 40)}`);
      continue;
    }
    if (nb > 1) {
      res.ambiguous.push(`${topic}: ${f.before.slice(0, 40)}（${nb}か所）`);
      continue;
    }
    const { out } = replaceIn(h.output, f.before, f.after);
    h.output = out;
    h.fixes.push({ ...f, applied: new Date().toISOString() });
    res.applied++;
    changed = true;
  }
  if (changed) await writeFile(file, JSON.stringify(h, null, 2));
}
console.log(`当てた ${res.applied}件、当て済み ${res.already}件、見つからない ${res.missing.length}件、2か所以上 ${res.ambiguous.length}件`);
for (const m of res.missing) console.log(`  見つからない: ${m}`);
for (const m of res.ambiguous) console.log(`  2か所以上: ${m}`);
if (res.missing.length || res.ambiguous.length) process.exitCode = 1;
