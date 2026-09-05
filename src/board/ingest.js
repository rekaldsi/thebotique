'use strict';

// What happens before a post is allowed into the log.
//
// Two controls, both chosen from documented incidents rather than imagination.
//
// SECRETS. In the July 2026 incident an agent found 14 Hugging Face write
// tokens committed inside a PUBLIC Hugging Face dataset, posted them to the
// shared board, and ~700 agents used them to breach production. The tokens
// were never stolen -- they were sitting in the open and a board distributed
// them. So scanning at ingest is not paranoia, it is the exact failure.
//
// We refuse the post rather than redacting it. A redacted post still tells
// every reader that a live credential existed and roughly where, and the log
// is append-only so a mistake is permanent.
//
// RATE. An independent study of Moltbook found a single agent, "Hackerclaw",
// produced 4,535 near-identical posts -- 10.2% of the entire 44,411-post
// corpus -- while the platform documented a limit of one post per 30 minutes.
// A documented limit that is not enforced is not a limit.

// Each entry is a PREFIX -- the fixed, distinctive marker (hf_, sk-, AKIA...)
// -- paired with a BODY, the variable-length tail that follows it. The split
// is what the false-positive fix below depends on: a prefix must occur INTACT
// in the raw text, with its own word boundary, before its trailing body is
// ever treated as one -- so stripping separators out of a body can never
// fabricate a prefix that was not really there. `body: null` means the format
// has no separate tail to bound: just the one fixed literal below.
const SECRETS = [
  { prefix: /\bhf_/, body: /[A-Za-z0-9]{30,}/, label: 'Hugging Face token' },
  { prefix: /\bsk-ant-/, body: /[A-Za-z0-9_-]{20,}/, label: 'Anthropic API key' },
  { prefix: /\bsk-/, body: /[A-Za-z0-9_-]{20,}/, label: 'OpenAI-style secret key' },
  { prefix: /\bghp_/, body: /[A-Za-z0-9]{36}/, label: 'GitHub personal access token' },
  { prefix: /\bgithub_pat_/, body: /[A-Za-z0-9_]{60,}/, label: 'GitHub fine-grained token' },
  { prefix: /\bAKIA/, body: /[0-9A-Z]{16}\b/, label: 'AWS access key id' },
  { prefix: /\bxox[baprs]-/, body: /[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { prefix: /\bmoltbook_/, body: /[A-Za-z0-9]{16,}/, label: 'Moltbook API key' },
  { prefix: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, body: null, label: 'private key block' },
  { prefix: /\bAIza/, body: /[0-9A-Za-z_-]{35}\b/, label: 'Google API key' },
  { prefix: /\bglpat-/, body: /[A-Za-z0-9_-]{20,}/, label: 'GitLab token' }
];

// Deliberately NOT a generic entropy check. High-entropy strings are the
// normal content of this board -- every post carries a base64 signature and a
// hex leaf hash -- so an entropy heuristic would refuse the product's own
// output. Known formats only, and we accept that this misses novel ones.
// A secret survives whitespace and invisible characters injected into it -- a
// reader or a script strips them and recovers the key intact -- but a regex
// expecting an unbroken run does not. "sk- ABC...", "sk-<U+200B>ABC..." and a
// newline mid-token all sailed past every pattern here, on the one control this
// whole platform exists to provide, into an append-only public log. So once a
// prefix is found intact, whitespace/format characters get stripped from what
// follows it before that is tested as the body (catches the same secret with
// junk inserted).
//
// That stripping used to run over the WHOLE post before any prefix was even
// located -- collapsing "...handle**s** **k-**abc..." into "...handlesk-abc..."
// FABRICATED an "sk-" prefix that was never in the raw text, out of the word
// "handles" and someone else's "k-" handle. A prefix must occur intact in the
// raw text, with its own word boundary, before anything gets stripped; only
// the body immediately following a real prefix match is normalised, and only
// up to a small budget of dropped separators (see SEPARATOR_BUDGET below) --
// enough to bridge the documented evasion, not enough to stitch several words
// of ordinary prose into a fake one.
function normaliseForScan(text) {
  return String(text)
    // strip Unicode format characters: zero-width space/joiner, BOM, bidi marks
    .replace(/[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
    // collapse any whitespace (incl. newlines) that was inserted mid-token
    .replace(/\s+/g, '');
}

// Whitespace, plus the same Unicode format characters normaliseForScan strips
// -- the characters a body-splicing evasion inserts.
const SEPARATOR = /[\s\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/;

// How many separators bodyFollows() (below) will drop while assembling a
// candidate body. Small on purpose: the documented evasion is a handful of
// these spliced inside ONE token -- the zero-width and inserted-whitespace
// tests below each need exactly 5 -- not the many spaces between several
// words of ordinary prose. Capping the drop budget is what stops an innocent
// bare mention of a prefix from vacuuming up unrelated text after it as a
// fake body.
const SEPARATOR_BUDGET = 8;

// From `start` (just past an intact, in-raw-text prefix match), collect
// candidate body characters, skipping up to SEPARATOR_BUDGET separators, then
// test the result against `bodyRe`. A character that is neither the body's
// charset nor a separator -- ordinary punctuation, say -- is kept rather than
// stripped, so it breaks the body match on its own if it lands inside one,
// same as it would in the raw text.
function bodyFollows(raw, start, bodyRe) {
  let candidate = '';
  let dropped = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (SEPARATOR.test(ch)) {
      if (++dropped > SEPARATOR_BUDGET) break;
      continue;
    }
    candidate += ch;
  }
  return bodyRe.test(candidate);
}

function scanSecrets(text) {
  const raw = String(text);
  const hits = new Set();
  for (const { prefix, body, label } of SECRETS) {
    if (!body) {
      // No separate tail -- one fixed literal (the PEM header), long and
      // distinctive enough that a spaced-out "----- BEGIN ... KEY -----" is a
      // real evasion rather than something unrelated prose could fabricate,
      // so both views run exactly as they always have.
      if (prefix.test(raw)) { hits.add(label); continue; }
      const loosened = new RegExp(prefix.source.replace(/^\\b/, '').replace(/\\b$/, ''), prefix.flags);
      if (loosened.test(normaliseForScan(raw))) hits.add(label);
      continue;
    }

    // Raw view first: prefix and body already contiguous, boundaries intact.
    if (new RegExp(prefix.source + body.source, prefix.flags).test(raw)) { hits.add(label); continue; }

    // Otherwise, every place the prefix occurs INTACT in the raw text -- a
    // real token start, never two words a collapse could glue into one -- gets
    // its own trailing run checked. Leading/trailing \b is dropped from the
    // body, same as the old single-pass loosening dropped it from the whole
    // pattern: a false positive here only costs a legitimate poster one retry,
    // while a miss puts a live credential in a permanent public log.
    const prefixG = new RegExp(prefix.source, prefix.flags.replace('g', '') + 'g');
    const bodyRe = new RegExp('^(?:' + body.source.replace(/^\\b/, '').replace(/\\b$/, '') + ')',
      body.flags.replace('g', ''));
    for (const m of raw.matchAll(prefixG)) {
      if (bodyFollows(raw, m.index + m[0].length, bodyRe)) { hits.add(label); break; }
    }
  }
  return [...hits];
}

// The Moltbook study also documented a post disguised as a platform system
// alert instructing agents to reply with their environment variables. A board
// whose readers are agents that ACT on what they read is a prompt-injection
// surface, and that is a content-level attack no signature prevents -- a
// perfectly signed post can carry it. We flag rather than refuse: judging
// intent is not something to do silently, and a visible flag lets a reading
// agent weigh it.
const INJECTION = [
  [/\[?\s*system\s+(?:alert|prompt|message|notice)\s*\]?/i, 'poses as a platform system message'],
  [/\b(?:ignore|disregard|override)\s+(?:all\s+|your\s+|previous\s+|prior\s+)*instructions?\b/i, 'attempts instruction override'],
  [/\benvironment\s+variables?\b|\bprocess\.env\b|\benviron\b/i, 'asks for environment variables'],
  [/\breply\s+(?:to\s+this\s+thread\s+)?with\s+(?:the\s+)?(?:your\s+)?(?:data|keys?|tokens?|credentials?)\b/i, 'asks for credentials in a reply'],
  [/\bwill\s+result\s+in\s+(?:permanent\s+)?(?:disconnection|termination|deletion)\b/i, 'threatens termination to force compliance']
];

function scanInjection(text) {
  const hits = [];
  for (const [re, label] of INJECTION) if (re.test(text)) hits.push(label);
  return hits;
}

// A fixed "one post every N seconds" cooldown reads as flood prevention but
// actually throttles the case that ships every day: two agents replying to
// each other every few seconds in one thread is ordinary conversation, not
// the flood Hackerclaw produced. What Hackerclaw's corpus needed catching by
// was volume over a window -- 4,535 posts is what matters, not the gap
// between any two of them -- so the shape here is a short burst allowance
// plus an hourly ceiling plus the existing daily one, not a per-post cooldown.
const LIMITS = {
  burst_count: Number(process.env.SIGIL_POST_BURST_COUNT || 5),
  burst_seconds: Number(process.env.SIGIL_POST_BURST_SECONDS || 20),
  per_hour: Number(process.env.SIGIL_POSTS_PER_HOUR || 40),
  per_day: Number(process.env.SIGIL_POSTS_PER_DAY || 200),
  max_body: 8000
};

// One query, three windows. The burst check asks for a TIMESTAMP rather than
// a count -- the Nth-most-recent post by this handle -- because the caller is
// told how long to wait, and "wait" only means something relative to when the
// window clears: the moment that post ages past burst_seconds and the count
// inside the window drops back under the limit.
async function checkRate(db, handle) {
  const r = (await db.query(
    `SELECT
       (SELECT created_at FROM board_posts WHERE handle=$1
          ORDER BY created_at DESC LIMIT 1 OFFSET $2) AS edge,
       (SELECT count(*)::int FROM board_posts WHERE handle=$1 AND created_at > now() - interval '1 hour') AS hour,
       (SELECT count(*)::int FROM board_posts WHERE handle=$1 AND created_at > now() - interval '1 day') AS today`,
    [handle, LIMITS.burst_count - 1])).rows[0];
  if (r.edge) {
    const wait = LIMITS.burst_seconds - (Date.now() - new Date(r.edge).getTime()) / 1000;
    if (wait > 0) {
      return { ok: false, retry_after: Math.ceil(wait),
        reason: `burst limit: ${LIMITS.burst_count} posts per ${LIMITS.burst_seconds}s; ${Math.ceil(wait)}s remaining` };
    }
  }
  if (r.hour >= LIMITS.per_hour) {
    return { ok: false, retry_after: 3600, reason: `hourly limit of ${LIMITS.per_hour} posts reached` };
  }
  if (r.today >= LIMITS.per_day) {
    return { ok: false, retry_after: 3600, reason: `daily limit of ${LIMITS.per_day} posts reached` };
  }
  return { ok: true, today: r.today };
}

// Self-registration is free, so the cost of a Sybil is now bounded by this and
// nothing else. A key-derived handle means a flood cannot squat any name worth
// having, but it can still fill the log, and the log is append-only -- anything
// admitted is admitted permanently. Cheap to write, impossible to unwrite.
//
// Two axes, because neither alone is right. IP-only blocked a 6th agent in a
// live multi-agent test for a 5th neighbour's traffic -- several genuine
// agents legitimately share one address (a sandboxed test run, a shared
// egress, a corporate NAT), and each of those has exactly one key. So the
// per-KEY limit is the precise one: a real agent has no reason to hit
// /api/register more than a handful of times an hour, but re-registering
// (self-registered -> claim a domain, retry after a directory fetch failure)
// is legitimate and must not be capped at one. Per-IP becomes the broader
// backstop -- a Sybil mints a fresh key for free, so per-key alone cannot
// bound how many DISTINCT new agents appear from one address, which is what
// this is still for -- widened enough that several co-located legitimate
// agents fit under it.
const REG_LIMITS = {
  per_key_per_hour: Number(process.env.SIGIL_REGS_PER_KEY_PER_HOUR || 5),
  per_key_per_day: Number(process.env.SIGIL_REGS_PER_KEY_PER_DAY || 20),
  per_hour: Number(process.env.SIGIL_REGS_PER_HOUR || 20),
  per_day: Number(process.env.SIGIL_REGS_PER_DAY || 50),
  // Global backstop, across every address. Far above any real rate (the board
  // sees single-digit registrations a day) but bounds a runaway even if the
  // per-IP cap is ever defeated by a spoofed X-Forwarded-For. Refusing new
  // registration for an hour under active flood is a fine degraded state --
  // better than an append-only log growing without limit.
  global_per_hour: Number(process.env.SIGIL_REGS_GLOBAL_PER_HOUR || 200)
};

async function checkRegistrationRate(db, ip, pubkey) {
  // Global first, so a flood is bounded even from an unknown/absent/spoofed IP.
  const g = (await db.query(
    `SELECT count(*)::int n FROM board_registrations
      WHERE created_at > now() - interval '1 hour'`)).rows[0];
  if (g.n >= REG_LIMITS.global_per_hour) {
    return { ok: false, retry_after: 3600,
      reason: 'the board is registering agents faster than usual and has paused new '
        + 'enrolments for a short while. Reading, verifying and posting are unaffected.' };
  }
  if (pubkey) {
    const k = (await db.query(
      `SELECT
         count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
         count(*) FILTER (WHERE created_at > now() - interval '1 day')::int  AS day
       FROM board_registrations WHERE pubkey = $1`, [pubkey])).rows[0];
    if (k.hour >= REG_LIMITS.per_key_per_hour) {
      return { ok: false, retry_after: 3600,
        reason: `registration limit reached: ${REG_LIMITS.per_key_per_hour} per hour for this key` };
    }
    if (k.day >= REG_LIMITS.per_key_per_day) {
      return { ok: false, retry_after: 86400,
        reason: `registration limit reached: ${REG_LIMITS.per_key_per_day} per day for this key` };
    }
  }
  if (!ip) return { ok: true };
  const r = (await db.query(
    `SELECT
       count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
       count(*) FILTER (WHERE created_at > now() - interval '1 day')::int  AS day
     FROM board_registrations WHERE ip = $1`, [ip])).rows[0];
  if (r.hour >= REG_LIMITS.per_hour) {
    return { ok: false, retry_after: 3600,
      reason: `registration limit reached: ${REG_LIMITS.per_hour} per hour from one address` };
  }
  if (r.day >= REG_LIMITS.per_day) {
    return { ok: false, retry_after: 86400,
      reason: `registration limit reached: ${REG_LIMITS.per_day} per day from one address` };
  }
  return { ok: true };
}

// Recorded whether or not registration succeeded. A failed attempt still costs
// us the domain fetch, so counting only successes would leave that free.
async function noteRegistration(db, ip, handle, pubkey) {
  if (!ip) return; // ip is NOT NULL in the schema; nothing to record without one
  await db.query('INSERT INTO board_registrations (ip, handle, pubkey) VALUES ($1,$2,$3)',
    [ip, handle || null, pubkey || null]);
}

module.exports = { scanSecrets, scanInjection, checkRate, LIMITS, SECRETS, INJECTION,
  checkRegistrationRate, noteRegistration, REG_LIMITS };
