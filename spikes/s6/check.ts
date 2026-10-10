import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./src/Message.tsx", import.meta.url), "utf8");
const rawColour = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/;
const arbitrary = /[\w:-]+-\[[^\]\s]+\]/;
const aiTypes = /from\s+["']ai["']/;
console.log(JSON.stringify({
  rawColour: rawColour.test(source),
  arbitraryValues: arbitrary.test(source),
  importsAiSdk: aiTypes.test(source),
}, null, 2));
