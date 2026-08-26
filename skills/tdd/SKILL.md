---
name: tdd
description: Test-first work when the same agent writes both the test and the code. Use when a change carries logic, state, or an interface other code depends on, and the seams to test are named or can be agreed.
---

# Test-Driven Development

The usual case for test-first is managing fear and getting feedback in small steps, and neither applies to you: you can write the test and the implementation in the same breath, so putting the test on disk first changes the order of writing without changing the thinking behind it. What survives is that a test written before the code cannot be shaped by it. That holds only when the expected answer came from somewhere other than the implementation, which is what everything below turns on.

## Where the test goes

A **seam** is the public boundary where behavior is observable without reaching inside. Tests live at seams and nowhere else, so a test that reads private state, swaps an internal collaborator, or checks the result through a side channel such as querying storage directly is testing the implementation, and it breaks on the next refactor that changes no behavior at all.

Work from the seams the brief names. When it names none, or the right boundary is not obvious, ask whoever dispatched you rather than picking one and building on it, because a test at a seam nobody agreed to is work that gets thrown away.

## Where the answer comes from

An expected value taken from the code under test is **laundered**. When the assertion calls the same helper, serializer or transform the implementation calls, both sides run the same logic, and the test cannot disagree with the code however wrong the code is. Expected values come from outside it: a worked example, the specification, a known good literal, a captured production sample.

The same failure wears a second face when a test **describes instead of requiring**. Asserting exact key names, exact error strings, or the precise shape a function happens to return records what the implementation does today. Assert the behavior that was asked for, and the test stops breaking on the parts that were never promised.

## The loop

**Red for the right reason.** Run the test before the code exists and read why it failed. A test that passes on its first run is testing nothing, and a failure nobody read is as easily a typo, a bad import or a fixture that never loaded as it is the missing capability. Quote the failure rather than asserting it happened.

**One slice at a time.** One seam, one test, one minimal implementation, then the next. Implementing ahead because the whole requirement is already in front of you is how the discipline quietly stops applying, since the following test then passes without ever going red.

**A blocking test is a finding.** When a test stands between you and green, hand it back. Editing an assertion, loosening a matcher or marking a case skipped closes the gap by deleting the thing that was checking you.

## What makes a test worth keeping

A green suite is a claim that something here turns red when the code regresses. These are the ways that claim goes hollow while the badge stays green.

A test that is not **hermetic** fails on its own schedule: a real clock, unseeded randomness, the network, shared filesystem state, an arbitrary sleep standing in for waiting on an observable condition, or an order dependence that surfaces only when the suite runs together. Tolerated flakiness teaches everyone to ignore failures, and the next real one gets ignored with them.

A mock returning exactly the shape the assertion expects has **replaced the logic rather than the boundary**. Mock what you do not own and leave the code under test real.

A test whose assertion never runs is **silent**, reporting a safety it does not provide. The cheap check is **the flip**: invert the assertion and run it again, because a test that passes both ways is asserting nothing. Generated tests fail this more than any other check, since a generator is optimising for green and a test that cannot fail is the cheapest green available.

A test that cannot say what broke is **undiagnosable**. Six steps with one assertion at the end goes red to report that something in there failed and leaves the reader to work out which. Each test covers one behavior and says which in its name, so the failure names it too and the test doubles as the clearest documentation that requirement will ever get.

Sources for the claims above: [SOURCES.md](SOURCES.md).
