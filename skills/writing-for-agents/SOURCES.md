# Sources

Where the claims in [SKILL.md](SKILL.md) come from. This file is for whoever maintains the skill. The agent running it does not need to read it.

## Why the wording has to be found rather than recalled

- [The wording effect](https://arxiv.org/html/2608.11694). Meaning-preserving rephrasings of the same problem span 74.7 percentage points on average between worst-case and best-case accuracy. Models largely agree on which rephrasings cost the most correct answers (mean pairwise Spearman 0.77), so the fragility belongs to the phrasing rather than to the model. A model's own confidence does not identify which of its answers will survive: nearly one in five of the answers it was most confident about is lost to a rephrasing that preserves meaning.
- [Do LLMs know internally when they follow instructions?](https://arxiv.org/html/2410.14516v5). Phrasing modifications correlate with the instruction-following dimension more strongly than task familiarity or instruction difficulty do. Failures come from sensitivity to exact phrasing rather than from ambiguity in the instruction.
- [Revisiting the reliability of language models in instruction-following](https://ar5iv.labs.arxiv.org/html/2512.14754). Prompts conveying the same intent with subtle differences drop even the most reliable model tested by 18.3%, and benchmark accuracy does not predict that stability.

## Why the name outweighs the prose around it

- [Small edits, big consequences](https://arxiv.org/html/2507.15868). A single descriptive identifier anchors the whole prompt: with the name intact, models still passed 85% of the time after 90% of the prompt was deleted, and masking that one name cut pass rates by 15 to 21 points. The same study found obscure terminology is ignored rather than learned, with jargon substitutions passing through 56% of the time, which is why a coinage costs definition tokens for a word the agent skips.
- [Grammar over vocabulary](https://chrishood.com/grammar-over-vocabulary-why-crud-fails-apis-for-agents/). Ablations across three frontier models: the name carries the primary selection signal and documentation is secondary. Stripping verbose descriptions raised accuracy from 75% to 88% because the prose was competing with the cleaner signal in the name. Semantic names survived deliberately misleading descriptions where generic names collapsed from 73% to 30%.

## Why concise phrasing over structural scaffolding

- [Constraint formatting](https://techloom.it/blog/constraint-formatting-experiment/), 4,680 benchmarks. Plain sentences beat XML tags, caps emphasis and numbered checklists for stating constraints. Numbered checklists did worst on instruction-following, 86.8 against 89.1, because numbering implies a sequence where constraints are independent.
- [Prompt design at scale](https://arxiv.org/html/2607.19257v1). No format wins across models or scales, and roughly 40 simultaneous instructions is a redesign point rather than a tuning point, with adherence at a floor by 80 regardless of which format carries the rules.
- [Directive versus narrative](https://georgesamuelson.com/blog/directive-vs-narrative). The counter-argument worth holding: on a literal-following model, narrative phrasing without a stated trigger is where interpretation drift happens. This is why a named principle still carries its trigger condition inside the sentence.

## Why an instruction the model already follows is worse than absent

- [Instruction compounding](https://www.howardism.dev/articles/instruction-compounding). An instruction naming a behaviour the model already has is additive rather than redundant, landing past the useful point, which is why the prescribed fix for such a line is deletion rather than rewording.
