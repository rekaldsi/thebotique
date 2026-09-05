'use strict';

// Upstream fetchers. Each returns normalized records:
//   { source, slug, version, repoUrl, upstreamAt, installs, downloads, versions, raw }
//
// Normalization matters more than it looks: the content hash is taken over
// the normalized record, so anything volatile that leaks in here (a
// timestamp, a view counter) turns every fetch into a false "changed".

const MCP_REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const CLAWHUB = 'https://clawhub.ai/api/v1/skills';
const UA = 'thebotique-collector/0.1 (+https://www.thebotique.ai)';

async function getJSON(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function githubRepo(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com\/([^/]+)\/([^/\s#?]+)/);
  return m ? `${m[1]}/${m[2]}`.replace(/\.git$/, '') : null;
}

// --- MCP Registry -----------------------------------------------------------
// Cursor-paginated, alphabetical by name. Version records repeat per server,
// so we keep only the latest observation per slug within a run.
async function fetchMcpRegistry({ maxPages = 20 } = {}) {
  const out = new Map();
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const url = `${MCP_REGISTRY}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let d;
    try {
      d = await getJSON(url);
    } catch (e) {
      break; // partial page set beats aborting the whole run
    }
    const servers = d.servers || [];
    if (!servers.length) break;
    for (const rec of servers) {
      const s = rec.server || {};
      if (!s.name) continue;
      const repoUrl = (s.repository && s.repository.url) || null;
      out.set(s.name, {
        source: 'mcp-registry',
        slug: s.name,
        version: s.version || null,
        repoUrl,
        repo: githubRepo(repoUrl),
        upstreamAt: pickTime(rec),
        installs: null,
        downloads: null,
        versions: null,
        // Only fields whose change we actually care about.
        raw: {
          name: s.name,
          title: s.title || null,
          description: s.description || null,
          version: s.version || null,
          repository: repoUrl,
          remotes: (s.remotes || []).map((r) => r.url).sort(),
          packages: (s.packages || []).map((p) => `${p.registryType || ''}:${p.identifier || ''}`).sort()
        }
      });
    }
    cursor = (d.metadata && d.metadata.nextCursor) || '';
    if (!cursor) break;
  }
  return [...out.values()];
}

function pickTime(rec) {
  const meta = (rec._meta || {})['io.modelcontextprotocol.registry/official'] || {};
  const t = meta.updatedAt || meta.publishedAt;
  return t ? new Date(t) : null;
}

// --- ClawHub ----------------------------------------------------------------
// Cursor is a JSON blob and MUST be URL-encoded. Sorted by by_active_updated,
// so page 1 is the most recently touched -- deliberately not a random sample.
async function fetchClawHub({ maxPages = 20 } = {}) {
  const out = new Map();
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const url = `${CLAWHUB}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let d;
    try {
      d = await getJSON(url);
    } catch (e) {
      break;
    }
    const items = d.items || [];
    if (!items.length) break;
    for (const i of items) {
      if (!i.slug) continue;
      const st = i.stats || {};
      out.set(i.slug, {
        source: 'clawhub',
        slug: i.slug,
        version: (i.tags && i.tags.latest) || (i.latestVersion && i.latestVersion.version) || null,
        repoUrl: null,
        repo: null,
        upstreamAt: i.updatedAt ? new Date(i.updatedAt) : null,
        installs: num(st.installs),
        downloads: num(st.downloads),
        versions: num(st.versions),
        raw: {
          slug: i.slug,
          displayName: i.displayName || null,
          summary: i.summary || null,
          description: i.description || null,
          topics: (i.topics || []).slice().sort(),
          latestVersion: (i.latestVersion && i.latestVersion.version) || null,
          changelog: (i.latestVersion && i.latestVersion.changelog) || null,
          license: (i.latestVersion && i.latestVersion.license) || null
        }
      });
    }
    cursor = d.nextCursor || '';
    if (!cursor) break;
  }
  return [...out.values()];
}

// --- Smithery ---------------------------------------------------------------
// Page/pageSize pagination. Richest source: carries `verified`, `useCount`
// and its own `inactive` flag. Note that last one -- Smithery already
// publishes a liveness signal, so we are not first here and should not
// claim to be.
async function fetchSmithery({ maxPages = 20 } = {}) {
  const out = new Map();
  for (let page = 1; page <= maxPages; page++) {
    let d;
    try {
      d = await getJSON(`https://registry.smithery.ai/servers?page=${page}&pageSize=100`);
    } catch (e) {
      break;
    }
    const servers = d.servers || [];
    if (!servers.length) break;
    for (const s of servers) {
      const key = s.qualifiedName || s.id;
      if (!key) continue;
      out.set(key, {
        source: 'smithery',
        slug: key,
        version: null,
        repoUrl: s.homepage || null,
        repo: githubRepo(s.homepage),
        upstreamAt: s.createdAt ? new Date(s.createdAt) : null,
        installs: num(s.useCount),
        downloads: null,
        versions: null,
        raw: {
          qualifiedName: key,
          displayName: s.displayName || null,
          description: s.description || null,
          homepage: s.homepage || null,
          owner: s.owner || null,
          verified: !!s.verified,
          remote: !!s.remote,
          isDeployed: !!s.isDeployed,
          inactive: !!s.inactive
          // useCount deliberately excluded: it ticks constantly and would
          // make every crawl look like a change.
        }
      });
    }
    const pg = d.pagination || {};
    if (pg.totalPages && page >= pg.totalPages) break;
  }
  return [...out.values()];
}

// --- npm --------------------------------------------------------------------
// Cross-vendor by construction: most MCP servers ship as npm packages
// regardless of which vendor's agent consumes them. Also the only source
// with real adoption numbers (weekly downloads) rather than self-reported
// install counts.
async function fetchNpm({ maxPages = 8, keyword = 'mcp' } = {}) {
  const out = new Map();
  const SIZE = 250;
  for (let page = 0; page < maxPages; page++) {
    let d;
    try {
      d = await getJSON(
        `https://registry.npmjs.org/-/v1/search?text=keywords:${encodeURIComponent(keyword)}&size=${SIZE}&from=${page * SIZE}`
      );
    } catch (e) {
      break;
    }
    const objs = d.objects || [];
    if (!objs.length) break;
    for (const o of objs) {
      const p = o.package || {};
      if (!p.name) continue;
      const repoUrl = (p.links && p.links.repository) || null;
      out.set(p.name, {
        source: 'npm',
        slug: p.name,
        version: p.version || null,
        repoUrl,
        repo: githubRepo(repoUrl),
        upstreamAt: p.date ? new Date(p.date) : null,
        installs: null,
        downloads: num(o.downloads && o.downloads.weekly),
        versions: null,
        raw: {
          name: p.name,
          version: p.version || null,
          description: p.description || null,
          license: p.license || null,
          publisher: (p.publisher && p.publisher.username) || null,
          maintainers: (p.maintainers || []).map((m) => m.username).filter(Boolean).sort(),
          repository: repoUrl,
          keywords: (p.keywords || []).slice().sort()
          // downloads excluded from the hash for the same reason as useCount.
        }
      });
    }
    if (objs.length < SIZE) break;
  }
  return [...out.values()];
}

// --- npm deep ---------------------------------------------------------------
// The registry SEARCH endpoint only returns descriptions and keywords, so
// hashing it detects documentation churn and nothing else. Measured on the
// first crawl: 86 artifacts changed, and every one was summary/description/
// changelog/topics -- zero permission, maintainer or dependency changes,
// because those fields simply are not in that payload.
//
// The per-package document is different. It exposes the fields that actually
// describe risk:
//   dist.integrity  - content hash of the published tarball. If this changes
//                     for a version that already existed, the artifact was
//                     replaced underneath everyone who pinned it.
//   scripts         - install/postinstall hooks, i.e. arbitrary code that
//                     runs at install time. This is the real attack surface.
//   dependencies    - new transitive surface.
//   maintainers     - publish rights changed hands.
//
// Bounded: one request per package, so we only enrich packages worth watching.
async function fetchNpmDeep(names = []) {
  const out = [];
  for (const name of names) {
    let d;
    try {
      d = await getJSON(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`, 15000);
    } catch (e) {
      continue; // a single unreachable package must not end the run
    }
    const latest = (d['dist-tags'] || {}).latest;
    const v = latest && d.versions ? d.versions[latest] : null;
    if (!v) continue;
    const repoUrl = (v.repository && (v.repository.url || v.repository)) || null;
    out.push({
      source: 'npm-deep',
      slug: name,
      version: latest,
      repoUrl: typeof repoUrl === 'string' ? repoUrl : null,
      repo: githubRepo(typeof repoUrl === 'string' ? repoUrl : null),
      upstreamAt: (d.time && d.time[latest]) ? new Date(d.time[latest]) : null,
      installs: null,
      downloads: null,
      versions: d.versions ? Object.keys(d.versions).length : null,
      raw: {
        name,
        latest,
        integrity: (v.dist && (v.dist.integrity || v.dist.shasum)) || null,
        // Install-time code execution. Sorted for hash stability.
        scripts: Object.keys(v.scripts || {}).sort()
          .reduce((o, k) => { o[k] = v.scripts[k]; return o; }, {}),
        dependencies: Object.keys(v.dependencies || {}).sort(),
        maintainers: (d.maintainers || []).map((m) => m.name).filter(Boolean).sort(),
        license: v.license || null,
        deprecated: v.deprecated || null,
        repository: typeof repoUrl === 'string' ? repoUrl : null
      }
    });
  }
  return out;
}

const num = (v) => (Number.isFinite(v) ? v : null);

module.exports = {
  fetchMcpRegistry, fetchClawHub, fetchSmithery, fetchNpm, fetchNpmDeep,
  githubRepo, getJSON
};
