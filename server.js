/*
 * UCSD CSI Chatbot — SHORT ANSWERS VERSION (no external APIs)
 * - Crawls getinvolved.ucsd.edu from seeds.json
 * - Builds a MiniSearch index over all pages
 * - /chat: multi-stage fuzzy search + fallback keyword match
 * - Returns a short, focused answer (a few sentences) + helpful links, using only CSI site content
 * - Skips PDFs / non-HTML so answers don't look like raw "%PDF" binary
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const cheerio = require('cheerio');
const MiniSearch = require('minisearch');
const PQueue = require('p-queue').default;
const robotsParser = require('robots-parser');

const ORIGIN = 'https://getinvolved.ucsd.edu';
const PORT = process.env.PORT || 3000;
const MAX_PAGES = Number(process.env.MAX_PAGES || 900);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);
const USER_AGENT = 'UCSD-CSI-Chatbot/1.0 (+contact: csifrontdesk@ucsd.edu)';
const FALLBACK_PHONE = process.env.FALLBACK_PHONE || '858-534-1733';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'csifrontdesk@ucsd.edu';

const dataDir = path.join(__dirname, 'data');
const indexPath = path.join(dataDir, 'index.json');
const seedsPath = path.join(__dirname, 'seeds.json');

fs.ensureDirSync(dataDir);

let robots = null;
let DOCS = [];
let mini = null;

function log(...args) {
  console.log('[csi]', ...args);
}

/* ---------- HTTP + robots helpers ---------- */

async function httpGet(url, config = {}) {
  return axios.get(url, {
    ...config,
    headers: { 'User-Agent': USER_AGENT, ...(config.headers || {}) },
    timeout: TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400
  });
}

function isSameOrigin(u) {
  try {
    return new URL(u).origin === ORIGIN;
  } catch {
    return false;
  }
}

function normalize(u) {
  return u.split('#')[0].replace(/\/$/, '');
}

async function loadRobots() {
  try {
    const res = await httpGet(ORIGIN + '/robots.txt', { validateStatus: () => true });
    robots = robotsParser(ORIGIN + '/robots.txt', res.data);
    log('robots.txt loaded');
  } catch {
    robots = robotsParser(ORIGIN + '/robots.txt', '');
    log('robots.txt missing; continuing cautiously');
  }
}

function allowed(url) {
  return robots ? robots.isAllowed(url, USER_AGENT) !== false : true;
}

/* ---------- Crawl + extract ---------- */

function extractDoc(url, html) {
  const $ = cheerio.load(html);
  ['script', 'style', 'noscript', 'iframe'].forEach((sel) => $(sel).remove());
  const title = ($('title').first().text() || '').trim();
  const h1 = $('h1')
    .map((_, el) => $(el).text().trim())
    .get()
    .join(' • ');
  const section = h1 || $('h2').first().text().trim() || '';
  const main = $('main').text() || $('body').text();
  const text = (main || '').replace(/\s+/g, ' ').trim();
  return { title, section, text, url };
}

async function crawlFromSeeds() {
  await loadRobots();
  const seeds = JSON.parse(fs.readFileSync(seedsPath, 'utf8'));
  const startUrls = Array.from(new Set(seeds.map(normalize).filter(isSameOrigin)));
  const seen = new Set();
  const queue = new PQueue({
    concurrency: CONCURRENCY,
    interval: 1000,
    intervalCap: CONCURRENCY
  });
  const results = [];

  function enqueue(u) {
    const n = normalize(u);
    if (!n || seen.has(n) || !isSameOrigin(n) || !allowed(n)) return;
    seen.add(n);
    if (seen.size > MAX_PAGES) return;

    queue.add(async () => {
      try {
        const res = await httpGet(n, { responseType: 'text' });
        const ct = (res.headers['content-type'] || '').toLowerCase();

        // Skip PDFs and other non-HTML responses so we don't index raw binary.
        if (!ct.includes('text/html')) {
          return;
        }

        const doc = extractDoc(n, res.data);
        results.push({ id: results.length, ...doc });

        const $ = cheerio.load(res.data);
        $('a[href]').each((_, a) => {
          const href = $(a).attr('href');
          if (!href) return;
          try {
            const abs = new URL(href, n).toString();
            if (isSameOrigin(abs)) enqueue(abs);
          } catch {}
        });
      } catch (e) {
        // Ignore individual page errors
      }
    });
  }

  startUrls.forEach(enqueue);
  await queue.onIdle();
  return results;
}

/* ---------- Index ---------- */

function buildIndex(docs) {
  const miniSearch = new MiniSearch({
    fields: ['title', 'section', 'text'],
    storeFields: ['url', 'title', 'section'],
    searchOptions: {
      boost: { title: 6, section: 3, text: 1 },
      prefix: true,
      fuzzy: 0.3,
      combineWith: 'OR'
    }
  });

  miniSearch.addAll(docs.map((d, i) => ({ id: i, ...d })));
  return miniSearch;
}

function saveIndex() {
  fs.writeJsonSync(indexPath, { docs: DOCS }, { spaces: 2 });
  log('index saved:', indexPath);
}

function loadIndexIfPresent() {
  if (!fs.existsSync(indexPath)) return false;
  try {
    const payload = fs.readJsonSync(indexPath);
    if (payload && Array.isArray(payload.docs)) {
      DOCS = payload.docs.map((d, i) => ({ id: i, ...d }));
      mini = buildIndex(DOCS);
      log('index loaded from disk:', DOCS.length, 'docs');
      return true;
    }
  } catch (e) {
    log('failed to load index from disk', e);
  }
  return false;
}

/* ---------- Intent + synonyms ---------- */

const INTENTS = [
  { id: 'hours', keywords: ['hour', 'hours', 'open', 'opening', 'closing', 'close', 'what time', 'when are you open', 'office hours'] },
  { id: 'location', keywords: ['where are you', 'location', 'address', 'price center', 'price centre', 'pce', 'map'] },
  { id: 'advisor', keywords: ['advisor', 'adviser', 'advising', 'silc', 'student organization advisor', 'meet with an advisor', 'drop-in advising', 'drop in advising', 'appointment'] },
  { id: 'tap', keywords: ['tap', 'triton activities planner', 'event request', 'event planning', 'venue request', 'space request', 'reservation', 'event form'] },
  { id: 'register', keywords: ['register', 'registration', 're-register', 'reregister', 'renew', 'renewal', 'new organization', 'starting a new org', 'principal member', 'community mentor'] },
  { id: 'finances', keywords: ['funding', 'finance', 'finances', 'money', 'slbo', 'fund manager', 'budget', 'account', 'reimbursement', 'payment'] },
  { id: 'service', keywords: ['service', 'volunteer', 'community service', 'alternative breaks', 'justicecorps', 'days of service', 'tritons take charge', 'community pathways'] },
  { id: 'leadership', keywords: ['leadership', 'ilead', 'communication & leadership', 'leadership conference', 'workshop', 'training'] },
  { id: 'sfl', keywords: ['sfl', 'fraternity', 'sorority', 'greek', 'greek life'] },
  { id: 'edi', keywords: ['edi', 'equity', 'diversity', 'inclusion', 'anti-racism', 'belonging'] },
  { id: 'jobs', keywords: ['job', 'jobs', 'work', 'hiring', 'employment', 'position', 'get paid', 'student staff'] }
];

const SYN_SETS = {
  tap: ['tap', 'triton activities planner', 'event planning', 'event request', 'venue', 'reservation', 'space', 'events', 'event form'],
  finances: ['finance', 'finances', 'funding', 'slbo', 'fund manager', 'budget', 'accounts', 'money'],
  advisor: ['advisor', 'advisors', 'advising', 'silc', 'student organization advisor', 'drop-in', 'drop in'],
  register: ['register', 'registration', 're-register', 'renew', 'principal member', 'community mentor', 'new org'],
  service: ['service', 'volunteer', 'community service', 'alternative breaks', 'justicecorps', 'days of service', 'tritons take charge', 'community pathways'],
  leadership: ['leadership', 'ilead', 'workshop', 'training', 'communication & leadership'],
  sfl: ['sfl', 'fraternity', 'sorority', 'greek life', 'greek'],
  edi: ['edi', 'equity', 'diversity', 'inclusion', 'anti-racism'],
  hours: ['hours', 'open', 'opening', 'closing', 'front desk'],
  location: ['location', 'address', 'price center', 'pce']
};

function classifyIntent(q) {
  const low = q.toLowerCase();
  for (const intent of INTENTS) {
    if (intent.keywords.some((k) => low.includes(k))) return intent.id;
  }
  return null;
}

function expandQuery(q, intent) {
  let s = q.toLowerCase();
  if (intent && SYN_SETS[intent]) {
    s += ' ' + SYN_SETS[intent].join(' ');
  }
  for (const key in SYN_SETS) {
    const terms = SYN_SETS[key];
    if (terms.some((t) => s.includes(t))) {
      s += ' ' + terms.join(' ');
    }
  }
  return s;
}

function getKeyTerms(q, intent) {
  const baseTerms = q
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t && t.length >= 3);
  let intentTerms = [];
  if (intent && SYN_SETS[intent]) {
    intentTerms = SYN_SETS[intent]
      .map((t) => t.toLowerCase().split(/\W+/))
      .flat();
  }
  const all = [...baseTerms, ...intentTerms];
  return Array.from(new Set(all));
}

function fallbackDocSearch(q, intent) {
  const terms = getKeyTerms(q, intent);
  if (!terms.length) return [];
  let best = null;
  DOCS.forEach((d, i) => {
    const hay = ((d.title || '') + ' ' + (d.section || '')).toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (hay.includes(t)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { id: i, score };
    }
  });
  return best ? [best] : [];
}

/* ---------- Snippet + SHORT answer composition ---------- */

function makeSnippet(text, keyTerms) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let idx = null;
  for (const term of keyTerms) {
    const p = lower.indexOf(term);
    if (p >= 0 && (idx === null || p < idx)) idx = p;
  }
  if (idx === null) idx = 0;
  const start = Math.max(0, idx - 180);
  const end = Math.min(text.length, idx + 420);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function snippetToFewSentences(snippet, maxSentences = 3) {
  if (!snippet) return '';
  const parts = snippet.split(/(?<=[.!?])\s+/);
  const trimmed = parts.slice(0, maxSentences).join(' ').trim();
  return trimmed;
}

function makeContextFromHit(hit, keyTerms) {
  const doc = DOCS[hit.id];
  const snippet = makeSnippet(doc.text || '', keyTerms);
  return {
    url: doc.url,
    title: doc.title || 'Result',
    section: doc.section || '',
    snippet
  };
}

function intentIntro(intent) {
  switch (intent) {
    case 'hours':
      return 'Here’s what the CSI site says about front desk hours: ';
    case 'location':
      return 'Here’s where CSI is located and how to find it: ';
    case 'advisor':
      return 'Here’s how you can connect with a Student Organization Advisor (SILC): ';
    case 'tap':
      return 'Here’s how TAP (Triton Activities Planner) works for events: ';
    case 'register':
      return 'Here’s how registering or re-registering your student org works: ';
    case 'finances':
      return 'Here’s how student org finances and funding are handled: ';
    case 'service':
      return 'Here are the service and community programs related to your question: ';
    case 'leadership':
      return 'Here are the Communication & Leadership options that may fit: ';
    case 'sfl':
      return 'Here’s what CSI shares about Fraternity & Sorority Life (SFL): ';
    case 'edi':
      return 'Here’s what the CSI site shares about equity, diversity, and inclusion: ';
    case 'jobs':
      return 'Here’s what I found about student jobs with CSI: ';
    default:
      return 'Here’s the most relevant information I found on the CSI site: ';
  }
}

function composeAnswer(question, intent, contexts) {
  const intro = intentIntro(intent);
  const main = contexts[0];

  const shortSnippet = snippetToFewSentences(main.snippet, 3);
  const core = shortSnippet || 'CSI has information on this topic on the linked page below.';

  const footer = ' For more details or specific edge cases, check the links below or contact the CSI front desk.';

  return (intro + core + footer).trim();
}

/* ---------- Express app ---------- */

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, pages: DOCS.length, indexed: !!mini });
});

app.post('/ingest', async (req, res) => {
  try {
    log('starting crawl from seeds.json');
    DOCS = await crawlFromSeeds();
    mini = buildIndex(DOCS);
    saveIndex();
    res.json({ ok: true, pages: DOCS.length });
  } catch (e) {
    log('ingest error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/chat', async (req, res) => {
  if (!mini) return res.status(503).json({ ok: false, error: 'Index not ready. Run POST /ingest first.' });

  const q = String(req.query.q || '').trim();
  if (!q) {
    return res.json({
      ok: true,
      intent: null,
      answerText: '',
      sources: [],
      fallback: { phone: FALLBACK_PHONE, email: CONTACT_EMAIL }
    });
  }

  const intent = classifyIntent(q);
  const expanded = expandQuery(q, intent);
  const keyTerms = getKeyTerms(q, intent);
  let hits = [];

  // 1) stricter search
  hits = mini.search(expanded, {
    fuzzy: 0.25,
    prefix: true,
    boost: { title: 8, section: 3, text: 1 },
    combineWith: 'AND'
  });

  // 2) more forgiving
  if (!hits.length) {
    hits = mini.search(expanded, {
      fuzzy: 0.4,
      prefix: true,
      boost: { title: 8, section: 3, text: 1 },
      combineWith: 'OR'
    });
  }

  // 3) raw question
  if (!hits.length) {
    hits = mini.search(q, {
      fuzzy: 0.5,
      prefix: true,
      boost: { title: 8, section: 3, text: 1 },
      combineWith: 'OR'
    });
  }

  // 4) title/section fallback
  if (!hits.length) {
    hits = fallbackDocSearch(q, intent);
  }

  // nudge front-desk for hours questions
  if (intent === 'hours' && hits.length) {
    const idx = hits.findIndex((h) => {
      const d = DOCS[h.id];
      const u = (d.url || '').toLowerCase();
      const t = (d.title || '').toLowerCase();
      return u.includes('front-desk') || t.includes('front desk');
    });
    if (idx > 0) {
      const [front] = hits.splice(idx, 1);
      hits.unshift(front);
    }
  }

  if (!hits.length) {
    return res.json({
      ok: true,
      intent,
      answerText: '',
      sources: [],
      fallback: { phone: FALLBACK_PHONE, email: CONTACT_EMAIL }
    });
  }

  const topHits = hits.slice(0, 3);
  const termsForSnip = keyTerms.length ? keyTerms : ['student', 'organization', 'csi'];
  const contexts = topHits.map((h) => makeContextFromHit(h, termsForSnip));
  const sources = contexts.map((c) => ({ url: c.url, title: c.title, section: c.section }));

  const answerText = composeAnswer(q, intent, contexts);

  res.json({
    ok: true,
    intent,
    answerText,
    sources,
    fallback: { phone: FALLBACK_PHONE, email: CONTACT_EMAIL }
  });
});

app.get('/dump', (req, res) => {
  res.json({ docs: DOCS });
});

if (!loadIndexIfPresent()) {
  log('no index file yet; run POST /ingest to crawl and build index');
} else {
  log('ready with pre-existing index');
}

app.listen(PORT, () => log('server listening on http://localhost:' + PORT));
