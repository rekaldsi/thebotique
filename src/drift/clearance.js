'use strict';

// The Clearance Record — a public, versioned specification.
//
// This page is the product's front door, not a lead magnet for it. The
// decision behind that: with no warm buyer in any segment, a published
// standard is what earns a first meeting. Nobody takes a call about a
// service. People cite a spec, and then they call the person who wrote it.
//
// Structure is generalised from a working three-gate system built for a
// national advertiser's dealer-advertising operation -- input gate, output
// gate, packaging gate, with claims bound to primary sources and offers
// bound to contract files that carry their own ratified disclaimer text.
// The generalisation removes everything brand-specific and keeps the shape.
//
// EDITORIAL RULE, non-negotiable: every check is tagged either
//   LAW      -- traces to a statute, regulation or collectively bargained
//               contract, cited by name, characterised narrowly.
//   PRACTICE -- a recommendation. Says so. Carries no legal claim.
// A false legal claim went live on this site once already (Art. 50 was
// described as exposing agencies when the marking obligation falls on
// providers). Nothing goes in this file that has not been checked against
// what the obligation actually says, and every doubtful case is PRACTICE.

const { esc, layout, SITE } = require('./render');

const VERSION = '0.2';
const PUBLISHED = '2026-08-30';

// tag, check, why it is there, source
const GATES = [
  {
    n: '01',
    name: 'Before generation',
    job: 'Stop work that cannot be cleared no matter how good it turns out.',
    checks: [
      ['PRACTICE', 'Territory is known and recorded before anything is made.',
       'Territory decides which rules apply at all, and it is cheapest to establish before anyone writes anything. NY GBL § 396-b reaches any ad with a New York audience regardless of where the advertiser sits; EU AI Act Article 50 turns on EU placement.',
       'NY GBL § 396-b; EU AI Act Art. 50'],
      ['PRACTICE', 'An offer is either attached or explicitly marked "none".',
       'Once a payment amount, payment count, down payment or finance charge appears in an ad, Regulation Z forces a specific set of further disclosures. Leases fall under Regulation M. "We will sort the legal line out later" is how the wrong line ships.',
       'TILA/Reg Z triggering terms; Reg M'],
      ['LAW', 'If a real person’s likeness or voice will be referenced or replicated, consent exists first.',
       'Under the 2025 SAG-AFTRA Commercials Contract a producer must give 48 hours’ notice before creating or using a digital replica and obtain written consent describing how it will be used. State right-of-publicity statutes apply independently of any AI rule.',
       'SAG-AFTRA 2025 Commercials Contract, Exhibit 3 rider'],
      ['PRACTICE', 'Claim sources are identified before the copy is written, not after.',
       'A claim invented in a draft and substantiated afterwards is the most common way an unsupportable line survives review — by then somebody likes it.',
       null],
      ['PRACTICE', 'The tool, model and account tier are chosen deliberately and written down.',
       'Indemnity attaches to the model, not the vendor. The same visual, made in the same application, in the same session, can carry uncapped indemnity or none at all depending on which model was selected. The files are indistinguishable afterwards.',
       null]
    ]
  },
  {
    n: '02',
    name: 'Before approval',
    job: 'Establish that what was made is supportable, and write down the parts that cannot be reconstructed later.',
    checks: [
      ['PRACTICE', 'Every claim traces to a named primary source, with a verifier and a date.',
       'A claims list is only as good as its weakest entry. Hold the source link, who checked it, and when — substantiation that lives in someone’s memory is not substantiation.',
       null],
      ['PRACTICE', 'Near-miss phrasings are caught mechanically, not by reading.',
       'Keep a short pattern list per claim — "mpg", "fuel economy", "efficiency" against a verified EPA figure. Nobody reads three hundred variants a month. A pattern list reads all of them and surfaces the eight that need a person. This is the single check that makes volume survivable.',
       null],
      ['PRACTICE', 'A synthetic performer is flagged as a field, including in the background.',
       'The statute compels a disclosure on the ad, not a field in a file. What it does do is turn on actual knowledge — which is why a flag somebody fills in beats an assumption nobody recorded. NY GBL § 396-b covers synthetic performers and is not limited to principals.',
       'NY GBL § 396-b'],
      ['PRACTICE', 'The human contribution is written down in plain language, with a named author.',
       'Copyright Office registration guidance requires applicants to disclose AI-generated material and identify what a human authored. Human authorship is also what any assignment of rights in a client contract actually rests on. It is the single hardest field to reconstruct six months later, and the only moment it is cheap is now.',
       'US Copyright Office, 16 Mar 2023 guidance; Thaler v. Perlmutter'],
      ['LAW', 'The disclaimer is present in its ratified wording, not a paraphrase.',
       'A disclaimer is a property of the offer, not of the script. Rewriting it to fit the layout is an edit to a legal instrument.',
       'Reg Z / Reg M; state UDAP'],
      ['PRACTICE', 'The disclosure decision is recorded with its reasoning and its decider — including when the answer is "no label needed".',
       'The IAB framework specifies a materiality test for whether to disclose. It legitimately produces "no" for a great deal of work. A documented decision not to disclose is defensible; an undocumented one is indistinguishable from never having considered it.',
       null],
      ['PRACTICE', 'Proof lives in supers and art cards, not in the emotional spine of the script.',
       'Craft rule with a governance consequence: claims collected in one place are claims that can be checked. Claims dissolved into voiceover cannot be diffed against a source list.',
       null]
    ]
  },
  {
    n: '03',
    name: 'Before release',
    job: 'Re-check the things that were true at approval and may not be true today.',
    checks: [
      ['LAW', 'The offer is still active on the release date — not the approval date.',
       'This is the check that gets skipped, because it passed once already. Offers are dated instruments and creative approval is not.',
       'Reg Z / Reg M; state UDAP'],
      ['LAW', 'Every licensed element is still in term, territory and media.',
       'Stock, music, photography, illustration and fonts each carry their own term. Statutory damages are assessed per work, which is why the exposure from a lapsed licence scales with the number of assets rather than the number of mistakes.',
       '17 U.S.C. § 504(c)'],
      ['LAW', 'Talent usage windows are open and holding fees are current.',
       'Under the SAG-AFTRA Commercials Contract the maximum period of use runs 24 months from ten business days after the start of principal photography, with holding fees on 13-week cycles. Continued use past it, after notice, exposes the producer to arbitration.',
       'SAG-AFTRA Commercials Contract, MPU'],
      ['PRACTICE', 'A named person can stop the release, and somebody checked that they have not.',
       'A kill switch nobody reads is a field, not a control. Bind it to the source contract, make it green-by-exception, and check it at export rather than at approval.',
       null],
      ['PRACTICE', 'The record is complete and hashed.',
       'Hash the record and the file together so the version that shipped is provably the version the record describes. Without it you have a document about an asset, not a record of one.',
       null]
    ]
  },
  {
    n: '04',
    name: 'After release',
    job: 'The obligations that keep running after everyone has moved on.',
    checks: [
      ['PRACTICE', 'Expiry alerts reach a named owner at 90, 30 and 7 days, and escalate.',
       'Every shop that answers a rights question quickly has one person who owns it. Every shop that answers slowly has a committee.',
       null],
      ['LAW', 'Digital replica destruction dates are honoured.',
       'Under the 2025 SAG-AFTRA contract, keeping a digital replica past the maximum period of use of the last commercial it appeared in requires fresh consent; otherwise it is to be destroyed. Producers are also obliged to limit access to replicas and use commercially reasonable efforts to secure them. This is an asset with a death date, and no asset manager enforces it by default.',
       'SAG-AFTRA 2025 Commercials Contract'],
      ['PRACTICE', 'The record survives the people. ',
       'The first time this record is needed, it will be needed for work that shipped months ago, made by people who have left.',
       null]
    ]
  }
];

const FIELDS = [
  ['The work', [
    ['Campaign, asset, version', 'The unit everything else attaches to.'],
    ['Markets and channels', 'Determines which rules are in scope.'],
    ['First release date', 'The date every term is measured against.']
  ]],
  ['How it was made', [
    ['Tool, model, model version', 'Indemnity attaches here, not to the vendor.'],
    ['Account or plan tier', 'Enterprise and individual plans carry different terms.'],
    ['Operator and date', 'Who ran it. Not who approved it.'],
    ['Prompt reference', 'Retained and findable. Not necessarily published.'],
    ['Reference inputs', 'Whether a real photograph, voice or performance went in.']
  ]],
  ['Who is in it', [
    ['Synthetic performer present', 'Including background. NY GBL § 396-b.'],
    ['Digital replica present', 'Links to the consent artifact and its scope.'],
    ['Replica destruction date', 'The field nothing else in your stack has.']
  ]],
  ['What it claims', [
    ['Claim → primary source', 'The document, not a summary of it.'],
    ['Verifier and verification date', 'A person and a day.'],
    ['Pattern list', 'The near-miss phrasings that trip review.']
  ]],
  ['What it offers', [
    ['Offer → source contract', 'The file, versioned and locked.'],
    ['Term, territory, eligibility', 'The three axes everything expires on.'],
    ['Ratified disclaimer text', 'Verbatim. A property of the offer.'],
    ['Status at release', 'Re-checked, not inherited from approval.']
  ]],
  ['What was decided', [
    ['Human contribution', 'Plain language, named author.'],
    ['Disclosure decision + reasoning', 'Including a documented "no".'],
    ['Indemnity resolution', 'Covered / not covered / unknown, with the cap and the condition that governs it.'],
    ['Approvals', 'Name, role, date.'],
    ['Export hash', 'Binds the record to the file.']
  ]]
];

function tag(t) {
  return t === 'LAW'
    ? '<span class="obs" style="color:var(--accent);border-color:var(--accent)">Law</span>'
    : '<span class="obs">Practice</span>';
}

function mount(router) {
  router.get('/clearance-record', (req, res) => {
    const gates = GATES.map((g) => `
<h2><span class="num">Gate ${g.n}</span>${esc(g.name)}</h2>
<p class="lede" style="font-size:19px;margin-bottom:22px">${esc(g.job)}</p>
${g.checks.map(([t, check, why, src]) => `<div class="band">
  <div>
    <p style="margin:0 0 6px"><strong>${esc(check)}</strong></p>
    <p style="margin:0 0 4px" class="note">${esc(why)}</p>
  </div>
  <div class="margin">${tag(t)}${src ? `<br>${esc(src)}` : ''}</div>
</div>
<hr style="border:0;border-top:1px solid var(--rule);margin:18px 0">`).join('')}`).join('');

    const fields = FIELDS.map(([group, rows]) => `
<h3 style="font-family:var(--mono);font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-2);margin:30px 0 0;font-weight:500">${esc(group)}</h3>
<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`).join('');

    res.send(layout({
      title: `The Clearance Record v${VERSION} — an open specification`,
      description: 'What must be true, and written down, before AI-assisted advertising ships. Four gates, tagged law or practice, with every legal check cited. Free to use, adapt and ignore.',
      canonical: `${SITE}/clearance-record`,
      noindex: true,
      jsonld: {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: `The Clearance Record v${VERSION}`,
        description: 'An open specification for what must be true, and written down, before AI-assisted advertising ships.',
        datePublished: PUBLISHED,
        version: VERSION,
        url: `${SITE}/clearance-record`,
        license: 'https://creativecommons.org/licenses/by/4.0/',
        publisher: { '@type': 'Organization', name: 'TheBotique', url: SITE }
      },
      body: `
<div class="card" style="border-color:var(--accent)">
<p style="margin:0 0 8px"><strong>Archived &mdash; <span class="date">31 August 2026</span></strong></p>
<p style="margin:0">This specification was written for a direction that was researched and
then set aside. The research found no party required to hold this record, that the IAB
publishes an equivalent free, and that a non-lawyer selling assessments against legal rules
runs at unauthorised practice of law.</p>
<p style="margin:12px 0 0">It stays up rather than being deleted, because its findings are
sourced and dated and because it carries its own published corrections &mdash; including
the two occasions on which it was wrong. Removing the record of that would be the wrong
instinct. It is no longer offered as a service and is excluded from search.</p>
</div>

<h1>The Clearance Record</h1>
<p class="lede">What has to be true &mdash; and written down &mdash; before AI-assisted
advertising ships. Four gates, 22 checks, one record. Free to use, adapt, fork or
ignore.</p>

<dl class="kv">
<dt>Version</dt><dd>${VERSION} &middot; published <span class="date">${PUBLISHED}</span></dd>
<dt>Licence</dt><dd>CC BY 4.0. Take it into your own documentation and change it.</dd>
<dt>Status</dt><dd>Draft. Written to be argued with &mdash; see <a href="#argue">below</a>.</dd>
</dl>

<h2><span class="num">Why</span>The disclosure record has an owner. The rest of the file does not.</h2>

<div class="card" style="border-color:var(--accent)">
<p style="margin:0 0 8px"><strong>Correction &mdash; <span class="date">30 August 2026</span></strong></p>
<p style="margin:0">Version 0.1 of this page claimed the industry had standardised the
disclosure <em>decision</em> and not the <em>record</em> of it. That was wrong on the day
it was published, and it was the load-bearing claim.</p>
<p style="margin:12px 0 0">The IAB's <em>AI Transparency and Disclosure Framework v2</em>,
published <span class="date">18 August 2026</span>, instructs advertisers to assign an
AI Disclosure Lead to oversee &ldquo;materiality assessments, documentation, and internal
training&rdquo;, to run a pre-launch checklist inside existing workflow tools, and to
&ldquo;document AI use across campaigns to support auditability&rdquo;. It defines two
C2PA assertions &mdash; <code>com.iab.threshold</code> and <code>com.iab.disclosure</code>
&mdash; for recording the determination before distribution, and carries a section headed
<em>Post-Publication (Archiving &amp; Audit)</em>.</p>
<p style="margin:12px 0 0"><strong>Use it.</strong> It is free, it is better distributed
than anything here, and it was built by a working group from Digitas, Acxiom, Cond&eacute;
Nast, MondelÄz, Warner Bros. Discovery and Tinuiti. This page is not a competitor
to it and should not be read as one.</p>
</div>

<p>What that framework does not cover is everything in the file that is not about AI
disclosure. Searched in full, v2 contains no mention of talent releases, usage windows,
holding fees, residuals, licence terms, expiry, territory, indemnity, or copyright
registration. On claims it is explicit, and it punts &mdash; correctly, because this is
not what it is for: <em>&ldquo;Advertisers remain responsible for the accuracy and
substantiation of all claims regardless of authorship method.&rdquo;</em></p>

<p>That remainder is the older and more expensive half, and it is where this page is
still useful: offers expire,
licences lapse, usage windows close, and claims need substantiating whether a model
wrote the line or a person did.</p>
<p>Generative tools did not create that job. They multiplied the rows and added columns
nobody has: which model made this, whose indemnity covers it, is there a synthetic
performer in the background, what did a human actually contribute, can it be registered
at all.</p>
<div class="pull">A 24-person animation studio published blog posts citing papers that
did not exist, let AI voiceover reach clients who could not tell, and entered
administration in July 2025. Its senior creative: &ldquo;They were causing problems. They
were making more work for everybody.&rdquo;</div>
<p class="note">That replaces a line this page previously carried &mdash; that production
cost collapsed while review cost did not. It reads well, but it traces to an unsigned post
by a company selling review-gate software, and it is not something anyone named has
established. The studio above is sourced: <em>Digiday</em>, 28&nbsp;August&nbsp;2025.
Note also that its failure was review being <em>skipped</em>, not a review queue
overflowing &mdash; a different problem from the one the tidy version describes.</p>

<h2><span class="num">How to read it</span>Law and practice are not the same thing</h2>
<p>Every check below is tagged. <strong>Law</strong> means it traces to a named statute,
regulation or collectively bargained contract, cited and characterised narrowly.
<strong>Practice</strong> means it is a recommendation and carries no legal claim.
Where there was any doubt, it is tagged practice.</p>
<p class="note">This distinction is doing real work. A great deal of what is currently
sold as AI compliance is practice dressed as obligation, and a buyer who discovers that
once stops believing the rest of it. Version 0.1 of this page got four checks wrong in
exactly that direction &mdash; tagged law where the statute compels something about the
<em>ad</em> and nothing about a <em>file</em>. They were retagged the same day.</p>

<div class="card" style="border-color:var(--accent)">
<p style="margin:0 0 8px"><strong>The most important sentence on this page: no statute
requires this record.</strong></p>
<p style="margin:0">The obligations run to the ad and to the conduct &mdash; disclose the
synthetic performer, state the APR correctly, get consent before the replica exists, stop
running the offer when it expires. Not one of them says <em>and keep a file</em>. New
York's synthetic performer law imposes no record-keeping duty at all, and penalises a
first violation at $1,000.</p>
<p style="margin:12px 0 0">So the honest case is not that you are compelled to hold a
record. It is that under a statute keyed to <em>actual knowledge</em>, and under client
contracts that increasingly carry audit rights, the record is how you show what you knew
and when. If that argument does not persuade you, the right decision is to not build one,
and this page will not pretend otherwise.</p>
</div>

${gates}

<h2><span class="num">The record</span>Twenty-six fields</h2>
<p>One record per asset. Most of it is filled in once, at generation, by the person who
made the thing &mdash; which is the only moment any of it is cheap.</p>
${fields}

<h2><span class="num">Honestly</span>What this does not do</h2>
<p>It is not legal advice, it is not a certification, and no accreditation exists for
it &mdash; anyone claiming otherwise is selling you something. It will not tell you
whether a specific line is compliant in a specific state; that is a question for
counsel, and a specification cannot carry that liability. It does not require software.
The first useful version of this in most shops is a spreadsheet with the right columns
and one named owner.</p>
<p>It also will not help if your position is that the paperwork can wait. That is a
defensible position. Nobody has been fined under the New York rule, it carries no
private right of action, and the state enforces it at $1,000 for a first violation. The
argument for doing this is not the penalty. It is that the first time you need the
record, you will need it retroactively, for work made by people who have left, while a
client waits.</p>

<h2 id="argue"><span class="num">Argue with it</span>Corrections wanted, credited</h2>
<p>This is version ${VERSION} of a draft. If a legal characterisation here is wrong,
narrow, or out of date, say so and it gets fixed with the correction logged in public.
Same if a check is missing, or if one of them is unworkable in a real approval chain
&mdash; that second failure is the more likely one and the harder to see from outside.</p>
<p><a class="cta" href="mailto:hello@thebotique.ai?subject=Clearance%20Record%20v${VERSION}">hello@thebotique.ai</a></p>

<h2><span class="num">Who wrote it</span>&nbsp;</h2>
<p>Twenty years in advertising, on both sides of this conversation.</p>
<p>The hard part was never the software. It is knowing what a business-affairs lead will
accept and what a creative team will actually fill in. Get either wrong and the record
never gets made.</p>
<p class="note">Related, and free: a <a href="/readiness">ten-question self-assessment</a>
on whether you could answer a client today, and an <a href="/drift">open research
archive</a> tracking how third-party AI tools change over time.</p>`
    }));
  });
  return router;
}

module.exports = { mount, VERSION, GATES, FIELDS };
