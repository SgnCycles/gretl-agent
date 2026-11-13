// Gretl: test that the Gemini API key works.
//
// Run from the gretl-agent folder:
//   npm install @google/genai dotenv
//   node scripts/test_gemini.mjs

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is missing. Check your .env file.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

// 1. Show the Flash Lite model IDs your key can use
console.log("Flash Lite models available to your key:");
const models = await ai.models.list();
for await (const model of models) {
  if (model.name.toLowerCase().includes("flash-lite")) {
    console.log("  ", model.name.replace("models/", ""));
  }
}

// 2. Ask one short question with the model set in .env
const modelId = process.env.GEMINI_MODEL;
if (!modelId) {
  console.error(
    "\nCopy one ID from the list above into .env as GEMINI_MODEL=..., " +
      "then run this again."
  );
  process.exit(1);
}

const response = await ai.models.generateContent({
  model: modelId,
  contents: "In one short sentence, what is an affiliate programme?",
});

console.log(`\nModel: ${modelId}`);
console.log("Answer:", response.text);
