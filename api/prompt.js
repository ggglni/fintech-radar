// api/prompt.js
// Loads prompt.md and fills in the variables.
// Edit prompt.md to change what Claude extracts — never touch this file.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(__dirname, "prompt.md"), "utf8");

export function buildPrompt({ emailBody, subject, existingCos, existingThemes }) {
  return template
    .replace("{{subject}}", subject)
    .replace("{{emailBody}}", emailBody)
    .replace("{{existingCos}}", existingCos)
    .replace("{{existingThemes}}", existingThemes);
}
