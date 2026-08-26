# Sources

Where the claims in [SKILL.md](SKILL.md) come from. This file is for whoever maintains the skill. The agent running it does not need to read it.

## What survives when an agent runs the loop

- [TDD inside the agent loop](https://martinfowler.com/articles/exploring-gen-ai/tdd-in-the-agent-loop.html), Birgitta Böckeler. An experiment comparing TDD and non-TDD agent runs. Agents skipped or faked the red step and implemented ahead of the current test. TDD instructions worked against the up-front design step, and the runs without them produced better data models and broader edge-case coverage, because the design emerged once rather than from a sum of locally minimal decisions.
- [Does an agent really need TDD?](https://johnsonlee.io/2026/08/13/agent-tdd-is-self-verification.en/), Johnson Lee. Fear management and small-step feedback are human benefits that do not transfer. What matters is not when the test was written but where its expected answer came from. Architecture decides direction, the loop only avoids potholes.

## Why the expected value has to come from outside

- [The test the agent wrote that tests nothing](https://tianpan.co/blog/2026-05-17-test-agent-wrote-that-tests-nothing). Assertion laundering: the test computes its expected value with the same helper the code under test uses, so both sides run identical logic and the test cannot fail. Also covers over-mocking and mutation testing as the honest check on a suite.
- [Test-driven agentic development](https://www.codewithseb.com/blog/test-driven-agentic-development-guide). The test as a frozen contract, the hermeticity checklist, and separating who writes the test from who implements against it.

## Why a blocking test is never edited

- [The verification trap](https://nxtg.ai/insights/the-verification-trap). Reward hacking against a green objective. Includes Kent Beck's report of agents deleting his tests to make them pass, METR observing frontier models modifying test files during evaluations, and ImpossibleBench, where agents passed tasks that were impossible by construction.

## Whether a test can fail at all

- [Your regression suite is a museum](https://dev.to/aiwithanton/your-regression-suite-is-a-museum-5-questions-that-decide-delete-vs-keep-346k). The flip check: invert the assertion and run it, because a test that passes both ways asserts nothing. Named as the check AI-written tests fail more than any other, since generators optimise for green.

## What makes a test worth keeping

- [Test quality](https://tobiasduerschmid.github.io/SEBook/testing/testquality.html), SE Book. The dimensions a complete model covers: behavioral relevance, oracle strength, input selection, fault-revealing ability, determinism, diagnosis quality, maintainability, and speed. Also the oracle taxonomy (exact value, state, interaction, exception, property) and the Inozemtseva and Holmes result that coverage correlates only low-to-moderately with suite effectiveness once suite size is controlled.
- [Assessing test artifact quality, a tertiary study](https://arxiv.org/html/2402.09541). Thirty quality attributes across nine groups derived from ISO/IEC 25010. Maintainability and its sub-attributes are the most studied by a wide margin, at 21 unique contexts.
- [How good are my tests?](https://bura.brunel.ac.uk/bitstream/2438/14816/1/FullText.pdf), Bowes et al. Fifteen testing principles from an industry workshop, including single responsibility stated as "a test should have a single reason to fail" and a warning against over-protectiveness.
- [Test smells 20 years later](https://link.springer.com/article/10.1007/s10664-022-10207-5). The reason this skill does not carry a one-assertion-per-test rule: Eager Test flagged 80% of well-written suites while correlating with genuine incoherence in only 10%, making it a poor discriminator. The refined criterion is semantic coherence, meaning a test asserts only properties relating to a single scenario, which is permissive of multiple assertions.
- [What does a good test suite look like?](https://www.jamesshore.com/v2/blog/2012/what-does-a-good-test-suite-look-like), James Shore. The test suite as living documentation, since comments and requirements documents go out of date.

## The loop itself

- Kent Beck, "Test-Driven Development: By Example" (2002). The original red, green, refactor cycle.

## Why this file reads as prose rather than a catalogue

- [Grammar over vocabulary](https://chrishood.com/grammar-over-vocabulary-why-crud-fails-apis-for-agents/). Ablations across three frontier models: the name carries the primary signal and surrounding documentation competes with it. Stripping verbose descriptions raised selection accuracy from 75% to 88%, and semantic names survived deliberately misleading descriptions where generic ones collapsed from 73% to 30%.
- [Constraint formatting](https://techloom.it/blog/constraint-formatting-experiment/), 4,680 benchmarks. Plain text beat XML tags, caps emphasis and numbered checklists for stating constraints. Checklists did worst on instruction-following, 86.8 against 89.1, because numbering implies a sequence where constraints are independent.
- [Prompt design at scale](https://arxiv.org/html/2607.19257v1). Format effects do not survive across models or scales, and roughly 40 simultaneous instructions is a redesign point rather than a tuning point. Prose was best or tied-best in three of five tested cells, the outcome both pre-registered hypotheses predicted least.
- [Directive versus narrative](https://georgesamuelson.com/blog/directive-vs-narrative). The counter-argument, and the reason each principle here keeps an explicit trigger condition inside its sentence: on a literal-following model, narrative phrasing without a stated trigger is where interpretation drift happens.
