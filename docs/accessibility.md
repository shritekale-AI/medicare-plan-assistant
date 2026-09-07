# Accessibility

The primary persona is **68 years old, with mild hearing loss, reads with glasses, and is afraid of clicking the wrong thing**. For this product accessibility isn't a compliance checkbox — it's the core use case. A Medicare shopping tool that only works for confident, dexterous, sighted users has failed at its actual job.

WCAG 2.2 Level AA is the target.

---

## What was implemented

### Perceivable

| Item | Implementation | WCAG |
|---|---|---|
| Base text size | 18px (`text-lg`) throughout conversation, not 14px | 1.4.4 |
| Contrast | Darkened interactive greens to `emerald-800`, body text `slate-700`+ on white, error text `red-900` on `red-50` | 1.4.3 |
| Content reflow | Fluid layout, no horizontal scroll to 320px | 1.4.10 |
| Not colour-alone | Trace panel entries carry text labels (`rules` / `retrieval`), not just colour | 1.4.1 |
| Decorative icons hidden | Mic glyph marked `aria-hidden`; the button carries a real label | 1.1.1 |

### Operable

| Item | Implementation | WCAG |
|---|---|---|
| Skip link | "Skip to message box", visible on focus | 2.4.1 |
| Focus visible | `focus:ring-4` on every interactive control — no invisible focus states | 2.4.7 |
| Target size | 56px (`h-14`) mic, send, and input — above the 44px minimum, deliberately generous for reduced dexterity | 2.5.8 |
| Keyboard operable | Everything reachable and actionable by keyboard; Enter sends, Shift+Enter newlines | 2.1.1 |
| Reduced motion | Auto-scroll switches to instant, pulse animations gated behind `motion-safe:` | 2.3.3 |
| No time limits | Nothing expires mid-conversation | 2.2.1 |

### Understandable

| Item | Implementation | WCAG |
|---|---|---|
| Real labels | `<label>` on the input, not a placeholder — placeholders vanish on typing and aren't reliably announced | 3.3.2 |
| Language | `lang="en"` on `<html>` | 3.1.1 |
| Plain language | System prompt requires jargon to be explained on first use: "maximum out-of-pocket" → "the most you'd pay in a year" | 3.1.5 |
| Error identification | Errors in a `role="alert"` region, announced immediately | 3.3.1 |

### Robust

| Item | Implementation | WCAG |
|---|---|---|
| New messages announced | `role="log"` + `aria-live="polite"` — announced without stealing focus, so a screen-reader user isn't yanked mid-sentence | 4.1.3 |
| Speaker identification | Visually hidden "You said:" / "Assistant replied:" prefixes, so turns aren't ambiguous in audio | 1.3.1 |
| Toggle state | Mic button exposes `aria-pressed` | 4.1.2 |
| Semantic landmarks | `header`, `main`, labelled regions | 1.3.1 |

### Voice as an accessibility feature — with a caveat

Speech input and output are first-class, which genuinely helps this audience. But **voice is never the only path**: every affordance has a text equivalent, `supported` is detected honestly rather than assumed, and the app is fully usable with speech off or unsupported.

Voice is an *alternative*, not a substitute for an accessible interface. A voice-only design would exclude the deaf and hard-of-hearing — a substantial share of a 65+ population, and the same population this product targets.

---

## What has NOT been done

Stated plainly rather than implied by omission.

| Gap | Why it matters |
|---|---|
| **No screen reader testing** | Implemented against the spec, not verified with NVDA, JAWS, or VoiceOver. Spec-compliant markup can still be confusing in practice — this is the biggest remaining gap |
| **No automated audit** | axe-core or Lighthouse should run in CI |
| **No testing with actual older users** | The persona is a composite, not a research participant. The real accessibility questions for this audience — anxiety, error recovery, trust — are behavioural and won't show up in a WCAG checklist |
| **Contrast not formally measured** | Ratios were improved by reasoning about Tailwind's scale, not verified with a contrast checker |
| **No zoom testing to 400%** | WCAG 1.4.10 requires it |
| **No cognitive-load assessment** | Long AI replies may exceed comfortable working memory. Progressive disclosure would likely help more than any markup change |
| **English only** | Humana publishes Spanish versions of every document; only English is indexed. For this population that's an equity gap, not a nice-to-have |

---

## The honest summary

The markup-level work is done and reasoned about carefully. The **verification** is not. In a real project the order would be reversed — audit first, fix against findings, retest — and a WCAG claim without screen-reader testing isn't a claim worth making.

What this represents: accessibility treated as a design constraint from the start rather than retrofitted, with the remaining gaps named rather than quietly left off the list.
