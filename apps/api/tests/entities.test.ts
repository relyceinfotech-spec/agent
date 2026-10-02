import { describe, expect, it } from "vitest";
import {
  containsExactEntity,
  extractKnownEntities,
  subjectEntityMismatchReason,
} from "../src/entities.js";

describe("entity-aware source matching", () => {
  it("prefers specific compound entities without dropping a separately named parent", () => {
    expect(extractKnownEntities("React Native release notes")).toEqual(["React Native"]);
    expect(extractKnownEntities("Compare React Native with React")).toEqual([
      "React Native",
      "React",
    ]);
  });

  it("distinguishes a sibling product from the requested parent entity", () => {
    expect(
      subjectEntityMismatchReason(
        "latest stable React release",
        "Releases Overview — React Native",
      ),
    ).toBe("Candidate names React Native, a more-specific entity than the requested React.");
    expect(containsExactEntity("Releases Overview — React Native", "React")).toBe(false);
    expect(containsExactEntity("React versions and release history", "React")).toBe(true);
    expect(
      subjectEntityMismatchReason("latest stable React release", "React and React Native releases"),
    ).toBe("Candidate names React Native, a more-specific entity than the requested React.");
  });

  it("keeps an explicitly requested compound entity eligible", () => {
    expect(
      subjectEntityMismatchReason(
        "latest stable React Native release",
        "React Native releases overview",
      ),
    ).toBeUndefined();
  });
});
