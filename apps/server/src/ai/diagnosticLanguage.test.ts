import { describe, it, expect } from "vitest";
import { findDiagnosticLanguage, findDiagnosticLanguageIn } from "./diagnosticLanguage.js";

describe("findDiagnosticLanguage", () => {
  // Each of these was produced by jina-vlm in live testing.
  it.each([
    "This could indicate that you may have diabetes or be at risk for developing it.",
    "The swelling and tenderness suggest a possible ligament or meniscus tear.",
    "These results are a sign of infection.",
    "You might have anaemia.",
    "The pattern is consistent with pneumonia.",
  ])("flags: %s", (text) => {
    expect(findDiagnosticLanguage(text)).not.toBeNull();
  });

  it.each([
    "Your fasting glucose is 182 mg/dL, which is above the reference range of 70-100.",
    "The doctor will review this result with you at your next visit.",
    "No signs of infection were recorded.",
    "Fracture was ruled out on the X-ray.",
    "Hemoglobin carries oxygen around the body.",
    "Take the tablet with food twice a day.",
  ])("leaves alone: %s", (text) => {
    expect(findDiagnosticLanguage(text)).toBeNull();
  });

  it("searches nested model output", () => {
    expect(
      findDiagnosticLanguageIn({
        explanation: "Fine.",
        notes: [{ test: "GLU", note: "This may indicate diabetes." }],
      }),
    ).toContain("diabetes");
    expect(findDiagnosticLanguageIn({ answer: "All good." })).toBeNull();
  });
});

describe("findDiagnosticLanguage — unnamed conditions", () => {
  it("flags vague condition claims seen in live output", () => {
    expect(
      findDiagnosticLanguage(
        "These results suggest that the patient may have a medical condition that requires further evaluation.",
      ),
    ).not.toBeNull();
  });

  it("leaves a medicine warning about existing conditions alone", () => {
    expect(
      findDiagnosticLanguage(
        "Tell your doctor about any medical conditions you have before starting.",
      ),
    ).toBeNull();
  });
});
