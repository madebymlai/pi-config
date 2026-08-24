import { readFileSync } from "node:fs";

// Blocks until stdin reaches EOF, so a caller that never closes stdin hangs here.
const prompt = readFileSync(0, "utf8");
const message = { role: "assistant", content: [{ type: "text", text: prompt }] };
process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
