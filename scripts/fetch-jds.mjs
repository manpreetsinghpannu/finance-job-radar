#!/usr/bin/env node
// One-off: download the full job description for every open role on both
// radars (UK + India) so they can be mined for CV keywords. Uses career-ops'
// fetch-jd (Greenhouse, Lever, Ashby, Workable, Workday, SmartRecruiters ...
// public APIs), LinkedIn's guest job page, and a plain page fetch as fallback.
// Writes reports/jds.jsonl.gz:  {url, company, title, location, radar, cv, text}
//
//   node scripts/fetch-jds.mjs --engine <career-ops dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
const ENGINE = arg('--engine');
const { fetchJdViaKnownApi } = await import(pathToFileURL(join(ENGINE, 'browser-extract.mjs')).href);
const { parsePipelineLine } = await import(pathToFileURL(join(process.cwd(), 'scripts/notify.mjs')).href);

const RAW = 'https://raw.githubusercontent.com/manpreetsinghpannu/finance-job-radar-india/main/';
async function getText(url, ms = 15000, headers = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 (finance-job-radar)', ...headers } }); return r.ok ? await r.text() : null; }
  catch { return null; } finally { clearTimeout(t); }
}
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

async function jdFor(row) {
  try { const r = await fetchJdViaKnownApi(row.url, 20000, 15000); if (r?.text?.length > 300) return { how: 'api', text: r.text }; } catch {}
  const li = row.url.match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/);
  if (li) {
    const h = await getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${li[1]}`);
    const m = h && h.match(/<div class="show-more-less-html__markup[^"]*">([\s\S]*?)<\/div>/);
    if (m) return { how: 'linkedin', text: strip(m[1]) };
    return null;
  }
  const h = await getText(row.url);
  if (!h) return null;
  const ld = h.match(/"description"\s*:\s*"((?:[^"\\]|\\.){300,})"/);
  if (ld) { try { return { how: 'jsonld', text: strip(JSON.parse(`"${ld[1]}"`)) }; } catch {} }
  const t = strip(h);
  return t.length > 1500 ? { how: 'page', text: t.slice(0, 20000) } : null;
}

const sources = [
  ['UK', readFileSync('data/pipeline.md', 'utf8'), JSON.parse(readFileSync('data/top-picks.json', 'utf8'))],
  ['India', await getText(RAW + 'data/pipeline.md'), JSON.parse((await getText(RAW + 'data/top-picks.json')) || '{}')],
];
const rows = [];
for (const [radar, text, picks] of sources) {
  for (const line of (text || '').split('\n')) {
    const r = parsePipelineLine(line); if (!r) continue;
    rows.push({ ...r, radar, cv: picks.assign?.[r.url]?.id || 'other' });
  }
}
console.log(`fetch-jds: ${rows.length} open roles`);
const out = []; const stats = {}; let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < rows.length) {
    const r = rows[i++];
    const jd = await jdFor(r);
    const k = jd ? jd.how : 'miss'; stats[k] = (stats[k] || 0) + 1;
    if (jd) out.push({ url: r.url, company: r.company, title: r.title, location: r.location, radar: r.radar, cv: r.cv, how: jd.how, text: jd.text.slice(0, 20000) });
    if (r.url.includes('linkedin.com')) await new Promise((s) => setTimeout(s, 1500));
  }
}));
mkdirSync('reports', { recursive: true });
writeFileSync('reports/jds.jsonl.gz', gzipSync(out.map((o) => JSON.stringify(o)).join('\n')));
console.log(`fetch-jds: ${out.length} descriptions saved`, JSON.stringify(stats));
