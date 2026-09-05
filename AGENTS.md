## Glossary

- **Complexity** is anything about the structure of a system that makes it hard to understand or modify. It shows as **change amplification** (one conceptual change has to be made in many places), **cognitive load** (how much a developer must hold in mind to make a change) and **unknown unknowns** (you cannot tell which code a change must touch, or what you needed to know), the worst of the three, because nothing announces it. Its causes are **dependencies**, where code cannot be understood in isolation, and **obscurity**, where important information is not obvious. It is not a line count: a longer version that lowers what the next reader must hold in mind is the simpler one. No single change makes a system complex; it accumulates in small increments, which is why each one is worth refusing.

## Review findings

Review findings are claims, not instructions. Before making review-driven edits, freeze the findings into a closed docket and classify each as FIX or WONTFIX against the governing spec and the changed lines, and only FIX where the fix adds no complexity. Address only FIX items.
