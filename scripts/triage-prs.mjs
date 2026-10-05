// Triage of the pull requests still open in the original project.
//
// Sixty-one patches from strangers, some from 2020. Reading them by hand is
// why they have sat there for years: this sorts them by whether they still
// apply and by how many people asked for them, so the ones worth the most and
// costing the least come first.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = 'Huachao/vscode-restclient';
const token = execSync('printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill', {
  shell: 'C:/Program Files/Git/bin/bash.exe', encoding: 'utf8'
}).split('\n').find(l => l.startsWith('password='))?.slice(9).trim();

const api = async (route) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}${route}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
  });
  if (!r.ok) throw new Error(`${route}: HTTP ${r.status}`);
  return r.json();
};

// No shell: the arguments go as an array, so nothing that comes from the API
// (a PR number, a title) can turn into a command.
const git = (args) => {
  try { return { ok: true, output: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '') }; }
};

console.log('fetching the open pull requests...');
const prs = [];
for (let page = 1; page <= 3; page++) {
  const batch = await api(`/pulls?state=open&per_page=100&page=${page}`);
  if (!batch.length) break;
  prs.push(...batch);
}
console.log(`${prs.length} open\n`);

const base = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const rows = [];

for (const pr of prs) {
  const votes = (await api(`/issues/${pr.number}`)).reactions?.total_count ?? 0;
  const paths = (await api(`/pulls/${pr.number}/files?per_page=100`)).map(f => f.filename);
  const docsOnly = paths.length > 0 && paths.every(f => /\.md$|^images\/|^docs\//.test(f));

  // Does it still apply on top of our main branch?
  const n = Number(pr.number);
  git(['fetch', 'origin', `pull/${n}/head:pr-${n}`, '--quiet']);
  const exists = git(['rev-parse', '--verify', `pr-${n}`]).ok;
  let status = 'no branch';
  if (exists) {
    const merge = git(['merge-tree', '--write-tree', base, `pr-${n}`]);
    status = merge.ok ? 'applies' : 'conflict';
  }

  rows.push({
    n: pr.number,
    title: pr.title.replace(/\s+/g, ' ').slice(0, 68),
    author: pr.user?.login ?? '?',
    date: pr.created_at.slice(0, 10),
    votes,
    files: paths.length,
    docsOnly,
    status,
    paths: paths.slice(0, 6)
  });
  process.stdout.write('.');
}
console.log('\n');

const order = (r) => (r.status === 'applies' ? 0 : 1) * 1000 - r.votes;
rows.sort((a, b) => order(a) - order(b));

const mark = { applies: 'APPLIES  ', conflict: 'conflict ', 'no branch': 'no branch' };
console.log('status    votes files  date        #     title');
for (const r of rows) {
  console.log(`${mark[r.status]} ${String(r.votes).padStart(5)} ${String(r.files).padStart(5)}  ${r.date}  ${String(r.n).padStart(5)}  ${r.title}${r.docsOnly ? '  [docs only]' : ''}`);
}

const applying = rows.filter(r => r.status === 'applies');
console.log(`\napply cleanly: ${applying.length} of ${rows.length}`);
console.log(`of those, with votes: ${applying.filter(r => r.votes > 0).length}`);
fs.writeFileSync('docs/triage-prs.json', JSON.stringify(rows, null, 2));
console.log('details in docs/triage-prs.json');
