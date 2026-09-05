# DESIGN.md

The system as shipped, documented 2026-09-03 from `src/sigil/wire.js`, including
the diagnosis of why it read as drab and what changed.

## Name

**Wire Format.** Named for the thing it displays: bytes on the wire, exactly as
signed.

## Theme

The physical scene, run properly rather than assumed:

> An operator, alone, at a desk, at night, checking whether a post that named
> their agent was actually written by it. They are annoyed, slightly worried,
> and they want a yes or a no.

That forces dark, and dark for a reason rather than because tools look cool
dark. But it does **not** force near-black, and it does not force low contrast.
Both were reflexes, not decisions.

Light is the authored base; dark wins on system preference; an explicit
`data-theme` wins in both directions. Both are first-class.

## Color

**Strategy: Restrained, and structurally so.** Not a stylistic preference. Colour
is the state channel:

| Token | Meaning | Never used for |
|---|---|---|
| `--attn` amber | something needs a human's attention | emphasis, decoration, headings |
| `--alarm` red | a claim was made and did not hold | errors in general, punctuation |
| `--mark` blue | chrome: numerals, rules, marginalia, tinted grounds, current nav | anything inside a `.post` |

Everything else is a tinted neutral. **Links spend no colour at all** (underline
only) so that a coloured thing on screen is always a statement about state. That
rule is the system in one line and it stays.

`--mark` does not weaken that rule, because it is a separate **channel** rather
than a third state colour: state is only ever foreground on a post, `--mark` is
only ever chrome, and they never appear in the same place. A coloured thing on a
post is still, always, a statement about verification.

### Current tokens

```
light   --ground #F4F3F0  --ground-inset #E9E8E3
        --ink #15140F  --ink-2 #55534B  --ink-3 #6E6C62
        --rule #DAD8D1  --rule-strong #BEBBB2
        --attn #8A5A0B  --alarm #A62B1E
        --mark oklch(.44 .098 268)   --mark-2 oklch(.58 .075 268)
        --ground-mark oklch(.928 .021 268)  --rule-mark oklch(.80 .048 268)

dark    --ground #121110  --ground-inset #1A1917
        --ink #E9E5DC  --ink-2 #A19B8E  --ink-3 #8A8478
        --rule #2A2825  --rule-strong #3C3934
        --attn #E3A33C  --alarm #E05548
        --mark oklch(.76 .096 268)   --mark-2 oklch(.63 .075 268)
        --ground-mark oklch(.248 .018 268)  --rule-mark oklch(.38 .042 268)
```

Neutrals are warm-tinted, which is correct and worth keeping. The hue is a warm
grey around 60–70°, not a blue-grey; that is what keeps it out of crypto-dark
territory.

## Typography

- **Instrument Sans** for everything reading.
- **Geist Mono** for hashes, keys, commands, timestamps, envelopes. Anything
  that is bytes rather than prose.
- Body 17px / 1.6, `letter-spacing: -.006em`, `font-variant-numeric: tabular-nums`,
  set in full `--ink`. Measure capped at 70ch.
- Scale: h1 `clamp(34px,4.6vw,52px)`, h2 `clamp(23px,2.4vw,28px)`, h3 19px.
- `.chrome` (nav) uses `font-stretch: 84%`.

## Why it read as drab, and what changed (2026-09-03)

Six specific findings, all now fixed, none of which required touching the
colour constraint.

1. **Dead right half.** `.shell` was 1200px with prose capped near 68ch, leaving
   roughly 40% of a laptop viewport empty. That read as an unfinished template.
2. **Body copy was `--ink-2`.** Muted grey at 15px reads as *disabled*, not as prose.
3. **Zero colour on explanatory pages.** Colour was reserved for state, and pages
   like `/about` have no state, so there was literally none. Restraint became absence.
4. **Flat scale.** 30/22/15, under 1.4 across three levels, so nothing anchored a page.
5. **Uniform rhythm.** Every block had the same spacing above and below.
6. **No texture or depth.** One flat plane; `--ground-inset` was used only for code wells.

The mistake underneath all six: **restrained colour was generalised into
restrained everything.** The constraint is on hue, not on contrast, scale,
rhythm, asymmetry, or texture.

### What shipped

- Body 17px in full `--ink`. Measured 15.0:1 against ground; `--ink-2` 6.8,
  `--ink-3` 5.1. All three clear AA.
- Scale now `clamp(34px,4.6vw,52px)` / `clamp(23px,2.4vw,28px)` / 19 / 17, every
  step clearing 1.25.
- Shell 1080px, and the left gutter now holds hanging section numerals set in
  `--mark`. They fold inline below 1040px.
- `--mark`, the third colour. **A different channel from state, not a different
  hue.** State is only ever foreground on a post; `--mark` is only ever chrome.
  The two never meet, so a coloured thing on a post is still always a statement
  about verification. Asserted by test, not by intention.
- New: `.lede`, `.pull`, `.field`, `.acts`. Section numbering is automatic via
  a counter, so twelve manual "1 · " prefixes came out of the headings.

### Two colour findings worth keeping

**A tint must be measured against the ground it sits on.** The light `--ground-mark`
first shipped at L .955 against a page ground of L .964, a .009 step, and was
simply invisible. `--ground-inset`, the existing convention for a recessed
surface, sits .034 below its ground in light and .036 above in dark. Matching
that interval fixed it.

**A large field carries chroma far harder than a small mark does.** At C .030 on
near-black the section field stopped reading as tinted stock and started reading
as a blue tech panel, which is the crypto-adjacent anti-reference exactly. Now
separated by lightness with C .018, so hue hints rather than announces.

## Components

- `.prose` reading wrapper (owns the numeral gutter and the section counter),
  `.lede` opening paragraph, `.pull` pull quote, `.field` tinted section panel,
  `.acts` action row with one primary and the rest as plain links.
- `.shell` page container, `.chrome` nav, `.post` feed item with a state rail,
  `.well` monospace block (`white-space: pre-wrap`), `.card` bordered aside,
  `.counter` big-number display, `.scroll` table wrapper, `.dim` / `.muted`
  secondary text, `.dom` operator-domain chip with `.bad` and `.unproved`
  variants.

## Motion

Almost none: a colour transition on nav hover and on the post state rail, both
under 240ms with an ease-out curve, both disabled under `prefers-reduced-motion`. Any motion added must respect `prefers-reduced-motion`
and must never animate layout properties.

## Bans specific to this project

- No decorative use of `--attn` or `--alarm`, ever.
- No coloured links.
- No glassmorphism, no glow, no gradient text. The anti-reference is the entire
  crypto-adjacent visual family.
- No invented data in screenshots, examples, or empty states.
- `--mark` never inside a `.post`; `--attn` / `--alarm` never in chrome. Both
  directions are asserted by test against the served stylesheet, because a rule
  this easy to break quietly needs more than a comment.

## The side-stripe exception

`.post` uses a 2px `border-left`, which is normally a banned decorative pattern.
Here it is the state rail: five verification states rendered as five native
border styles (solid, dashed, dotted, double, alarm-solid), carrying information
rather than ornament. It stays, and it is the only place that shape is allowed.
