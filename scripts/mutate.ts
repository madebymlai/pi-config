/**
 * Mutation testing: break the code on purpose, and see whether the tests notice.
 *
 * A passing suite says the code does what the tests check. It says nothing about
 * what the tests forgot to check, and reading them will not tell you either: an
 * untested branch looks exactly like a tested one. So this flips operators one at
 * a time and reports every mutation the suite let through.
 *
 * Two kinds of survivor come out, and they want opposite fixes:
 *
 *   - a real gap, where the mutation changes behaviour nobody asserts on. Write
 *     the missing test.
 *   - an equivalent mutant, where the mutation cannot change behaviour because
 *     the code it touched was redundant. Delete the code. Two dead branches in
 *     observe/liveness.ts were found exactly this way, by being unkillable.
 *
 * Deciding which is which is the judgement this tool cannot make for you, so it
 * reports rather than scores.
 *
 * Usage:
 *   bun scripts/mutate.ts <source.ts> <test.ts> [more-tests.ts...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { relative } from "node:path";

/** Flips that change behaviour without changing types, so the mutant still runs. */
const OPERATORS: Array<[RegExp, string]> = [
  [/(?<![<>=!])>=(?!=)/g, ">"],
  [/(?<![<>=!])<=(?!=)/g, "<"],
  [/(?<![<>=!])>(?!=)/g, ">="],
  [/(?<![<>=!])<(?!=)/g, "<="],
  [/===/g, "!=="],
  [/!==/g, "==="],
  [/&&/g, "||"],
  [/\|\|/g, "&&"],
  [/\?\?/g, "||"],
];

interface Mutant {
  line: number;
  text: string;
  description: string;
}

/** Every single-operator mutation of the file, skipping comments. */
function generate(source: string): Mutant[] {
  const lines = source.split("\n");
  const mutants: Mutant[] = [];
  let inBlockComment = false;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("/*")) inBlockComment = true;
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

    for (const [pattern, replacement] of OPERATORS) {
      for (const match of line.matchAll(pattern)) {
        const at = match.index;
        mutants.push({
          line: index,
          text: line.slice(0, at) + replacement + line.slice(at + match[0].length),
          description: `L${index + 1}: ${match[0]} -> ${replacement}  |  ${trimmed.slice(0, 68)}`,
        });
      }
    }
  });

  return mutants;
}

function runTests(testFiles: string[]): "pass" | "fail" | "broken" {
  const result = spawnSync("npx", ["tsx", "--test", ...testFiles], { encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  if (output.includes("SyntaxError") || output.includes("Cannot find")) return "broken";
  return result.status === 0 ? "pass" : "fail";
}

function main(): number {
  const [sourceFile, ...testFiles] = process.argv.slice(2);
  if (!sourceFile || testFiles.length === 0) {
    console.error("usage: bun scripts/mutate.ts <source.ts> <test.ts> [more-tests.ts...]");
    return 2;
  }

  const original = readFileSync(sourceFile, "utf8");
  const originalLines = original.split("\n");
  const mutants = generate(original);

  if (runTests(testFiles) !== "pass") {
    console.error(`The suite already fails on unmutated ${sourceFile}. Fix that first.`);
    return 2;
  }

  console.log(`${mutants.length} mutants for ${relative(process.cwd(), sourceFile)}\n`);
  const survivors: string[] = [];
  let killed = 0;
  let broken = 0;

  try {
    mutants.forEach((mutant, index) => {
      const mutated = [...originalLines];
      mutated[mutant.line] = mutant.text;
      writeFileSync(sourceFile, mutated.join("\n"), "utf8");

      const outcome = runTests(testFiles);
      if (outcome === "broken") broken += 1;
      else if (outcome === "fail") killed += 1;
      else survivors.push(mutant.description);

      process.stdout.write(
        `\r  ${index + 1}/${mutants.length}  killed=${killed} survived=${survivors.length}`,
      );
    });
  } finally {
    // Always restore, including on Ctrl-C: a half-mutated source file left behind
    // is far worse than a lost run.
    writeFileSync(sourceFile, original, "utf8");
  }

  const score = mutants.length - broken > 0 ? Math.round((killed / (mutants.length - broken)) * 100) : 0;
  console.log(`\n\nkilled ${killed}, survived ${survivors.length}, unrunnable ${broken}  (score ${score}%)\n`);
  for (const survivor of survivors) console.log(`  ${survivor}`);
  if (survivors.length > 0) {
    console.log("\nEach survivor is either a missing test or dead code. Decide which.");
  }
  return 0;
}

process.exit(main());
