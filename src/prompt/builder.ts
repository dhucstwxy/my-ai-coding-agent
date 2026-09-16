import { buildSections } from "./sections.js";
import {
  STABLE_SECTION_IDS,
  type BuildPromptInput,
  type BuildPromptResult,
  type PromptSection,
} from "./types.js";

const STABLE_SET = new Set(STABLE_SECTION_IDS);

function joinSections(sections: PromptSection[]): string {
  return sections
    .filter((s) => s.content.trim().length > 0)
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.content.trim())
    .join("\n\n");
}

export function buildPrompt(input: BuildPromptInput): BuildPromptResult {
  const sections = buildSections(input);
  const stableSystem = joinSections(
    sections.filter((s) => STABLE_SET.has(s.id)),
  );
  const fullSystem = joinSections(sections);
  return { stableSystem, fullSystem, sections };
}

export class PromptBuilder {
  build(input: BuildPromptInput): BuildPromptResult {
    return buildPrompt(input);
  }
}
