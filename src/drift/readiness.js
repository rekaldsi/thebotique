'use strict';

// Free AI disclosure readiness self-assessment.
//
// The lead magnet, not the product. It is deliberately a self-assessment
// rather than an automated scan: nothing about an agency's internal
// disclosure practice is observable from outside, and pretending otherwise
// would be the same overreach as the "AI visibility" tools that score a
// site on a metric they cannot actually measure.
//
// No account, no email gate, no score stored. Someone should be able to run
// it, learn something, and leave — the credibility of the answer is the
// marketing. Gating it would halve the reach and cheapen the artifact.
//
// Every question maps to a real obligation with a citation. Nothing here is
// invented urgency.

const { esc, layout, SITE } = require('./render');

const QUESTIONS = [
  {
    id: 'territory',
    q: 'Do you know, for each live campaign, whether it reaches a New York or EU audience?',
    why: 'Territory decides which rules apply at all. NY GBL § 396-b applies to any ad reaching a New York audience regardless of where the advertiser sits, and EU AI Act Art. 50 applies on EU placement.',
    weight: 2
  },
  {
    id: 'tools',
    q: 'Could you list every generative tool and model version used on a specific asset that shipped three months ago?',
    why: "The ANA gen-AI contract rider obliges agencies to disclose AI model training methods and data sourcing. That is per-engagement, and it is retrospective the first time a client asks.",
    weight: 3
  },
  {
    id: 'human',
    q: 'Is there a written record of what a human actually contributed to each AI-assisted asset?',
    why: 'Human authorship is what copyright attaches to, and what "meaningful human oversight" means when counsel asks. It is also the hardest thing to reconstruct after the team has moved on.',
    weight: 3
  },
  {
    id: 'synthetic',
    q: 'Do you track which assets contain an AI-generated human figure or voice — including background performers?',
    why: 'NY GBL § 396-b covers synthetic performers including background performers, and turns on actual knowledge. $1,000 first violation, $5,000 each subsequent.',
    weight: 3
  },
  {
    id: 'decision',
    q: 'When you decide NOT to disclose AI use, is that decision written down with its reasoning?',
    why: 'A documented decision not to disclose is a defence. An undocumented one is not. The IAB V2 materiality test legitimately produces "no" for most work — the value is having decided it, on a date, by name.',
    weight: 3
  },
  {
    id: 'policy',
    q: 'Does your shop have a written position on when AI use gets disclosed, agreed with legal?',
    why: 'IAB data: 89% of advertisers disclose AI usage, but fewer than half do so consistently. Consistency is a policy problem, not an intent problem.',
    weight: 2
  },
  {
    id: 'contract',
    q: 'Do your current client contracts say anything specific about AI use?',
    why: 'Adweek/NewtonX, March 2026: 39% of agency contracts do not address AI at all, and 27% only in broad terms.',
    weight: 2
  },
  {
    id: 'retention',
    q: 'Are prompts, seeds and source generations retained somewhere findable after the campaign ends?',
    why: 'The record you need is the one from the day the work was made. Retention is what makes it available when the question arrives two years later.',
    weight: 2
  },
  {
    id: 'owner',
    q: 'Is there a named person who answers if a client asks how AI was used on their campaign?',
    why: 'Every shop that answers this quickly has one person who owns it. Every shop that answers slowly has a committee.',
    weight: 1
  },
  {
    id: 'vendor',
    q: 'Have you confirmed commercial-use and indemnification terms for each AI tool your team uses?',
    why: 'Tool terms differ sharply on commercial use and indemnity, and teams adopt tools faster than procurement reviews them.',
    weight: 2
  }
];

const MAX = QUESTIONS.reduce((n, q) => n + q.weight, 0);

function band(pct) {
  if (pct >= 80) {
    return {
      label: 'You could answer a client tomorrow',
      note: 'You are in a small minority. The useful next step is spot-checking a real asset that shipped three months ago against what you believe your process captures — the gap between policy and practice is usually where the surprise is.'
    };
  }
  if (pct >= 50) {
    return {
      label: 'You could answer, but it would take a week and some guessing',
      note: 'This is the common case. The parts that are missing are usually human authorship and the written disclosure decision, because those are the two that have to be captured at the time and cannot be reconstructed from files.'
    };
  }
  if (pct >= 25) {
    return {
      label: 'You would be reconstructing it under pressure',
      note: 'The risk here is not a fine. It is that the first time you need this record you will need it retroactively, for work made by people who have moved on, while a client waits.'
    };
  }
  return {
    label: 'There is no record to produce',
    note: 'Worth knowing rather than assuming. The fastest improvement is not a system — it is deciding, in writing, when you disclose, and naming who owns the answer.'
  };
}

function mount(router) {
  router.get('/readiness', (req, res) => {
    // Answers arrive as ?q_<id>=yes|no|partly. Rendered server-side, nothing
    // stored, no JavaScript required.
    const answered = QUESTIONS.some((q) => req.query[`q_${q.id}`]);
    let score = 0;
    if (answered) {
      for (const q of QUESTIONS) {
        const a = req.query[`q_${q.id}`];
        if (a === 'yes') score += q.weight;
        else if (a === 'partly') score += q.weight / 2;
      }
    }
    const pct = Math.round((score / MAX) * 100);
    const b = band(pct);

    const form = `<form method="get" action="/readiness">
${QUESTIONS.map((q, i) => {
  const cur = req.query[`q_${q.id}`];
  return `<div class="card">
<p style="margin:0 0 10px"><strong>${i + 1}.</strong> ${esc(q.q)}</p>
<p style="margin:0 0 12px" class="muted">${esc(q.why)}</p>
${['yes', 'partly', 'no'].map((v) => `<label style="margin-right:18px;font-size:14px;cursor:pointer">
<input type="radio" name="q_${q.id}" value="${v}"${cur === v ? ' checked' : ''}> ${v === 'partly' ? 'partly' : v}
</label>`).join('')}
</div>`;
}).join('')}
<p><button type="submit" class="cta">See where you stand</button></p>
</form>`;

    const result = answered ? `
<div class="card" style="border-color:var(--accent)">
<p class="obs" style="margin-bottom:10px">${pct}% of the things that make this answerable</p>
<h2 style="margin:0 0 8px">${esc(b.label)}</h2>
<p style="margin:0">${esc(b.note)}</p>
</div>
<p class="muted">Nothing you entered was stored or sent anywhere. Reload and it is gone.</p>` : '';

    res.send(layout({
      title: 'AI disclosure readiness — a ten-question self-assessment — TheBotique',
      description: 'Ten questions on whether your shop could answer a client asking how AI was used on their campaign. Free, no signup, nothing stored. Each question maps to a live obligation.',
      canonical: `${SITE}/readiness`,
      body: `
<h1>Could you answer a client who asks how AI was used on their campaign?</h1>
<p class="lede">Ten questions. Two minutes. Nothing is stored and there is no signup —
the answer is only useful if it is honest, and people are not honest with a form that
emails them.</p>

<div class="card"><p style="margin:0" class="muted">Two rules came into force this
summer, and both turn on what you can show you knew:
<strong>NY GBL &sect; 396-b</strong> (9 June 2026, synthetic performer disclosure,
keyed to actual knowledge) and <strong>EU AI Act Article 50</strong> (2 August 2026,
transparency, up to &euro;15M or 3% of global turnover). Separately the
<strong>ANA gen-AI contract rider</strong> obliges agencies to disclose which models
were used and how they were trained.</p></div>

${result}
${form}

<h2>What this is not</h2>
<p class="muted">Not a legal opinion, not a compliance certification, and not scored
against any official standard. It is ten questions I would ask in a first conversation,
weighted by how hard each one is to fix after the fact. If you score badly on the
retrospective questions and well on the policy ones, that is normal and it is the
usual place to start.</p>

<p><a href="/">&larr; TheBotique</a></p>`
    }));
  });
  return router;
}

module.exports = { mount, QUESTIONS };
