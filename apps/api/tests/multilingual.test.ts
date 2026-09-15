import { describe, expect, it } from "vitest";
import { detectLanguage, detectFormatPreference } from "../src/planner.js";

describe("multilingual language & format detection", () => {
  it("detects Tamil script correctly", () => {
    const lang = detectLanguage("React இன் latest version என்ன?");
    expect(lang.detected).toBe("ta");
    expect(lang.name).toBe("Tamil");
    expect(lang.respondIn).toContain("Tamil");
  });

  it("detects Tanglish (conversational Tamil in Latin script)", () => {
    const lang1 = detectLanguage("react oda latest version enna bro?");
    expect(lang1.detected).toBe("ta-Latn");
    expect(lang1.name).toBe("Tanglish");

    const lang2 = detectLanguage("Supabase epdi irukku compare pannunga");
    expect(lang2.detected).toBe("ta-Latn");
  });

  it("detects Hindi script correctly", () => {
    const lang = detectLanguage("React का latest version क्या है?");
    expect(lang.detected).toBe("hi");
    expect(lang.name).toBe("Hindi");
  });

  it("detects Hinglish (conversational Hindi in Latin script)", () => {
    const lang = detectLanguage("React ka latest version kya hai bhai?");
    expect(lang.detected).toBe("hi-Latn");
    expect(lang.name).toBe("Hinglish");
  });

  it("detects English as default", () => {
    const lang = detectLanguage("What is the latest React version?");
    expect(lang.detected).toBe("en");
    expect(lang.name).toBe("English");
  });

  it("detects adaptive format preferences correctly", () => {
    expect(detectFormatPreference("Compare React Native and Flutter performance")).toBe(
      "comparison",
    );
    expect(detectFormatPreference("What's the latest React version?")).toBe("lookup");
    expect(detectFormatPreference("Show me python code for binary search")).toBe("code");
    expect(detectFormatPreference("Explain JavaScript closures simply")).toBe("direct");
    expect(
      detectFormatPreference("Comprehensive deep dive into database concurrency", "deep"),
    ).toBe("research");
  });
});
