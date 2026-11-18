import { describe, it, expect } from "vitest";
import { flagMismatch, testsFromTranscription } from "./flagConsistency.js";

const sheet = `CITY LAB - Report

Haemoglobin: 10.9 g/dL (ref 12.0-15.5) LOW

WBC: 7.2 x10^9/L (ref 4.0-11.0)

Platelets: 250 x10^9/L (ref 150-400)

Fasting glucose: 182 mg/dL (ref 70-100) HIGH`;

describe("testsFromTranscription", () => {
  it("reads each test line and its flag", () => {
    expect(testsFromTranscription(sheet)).toEqual([
      { names: ["Haemoglobin"], flag: "LOW" },
      { names: ["WBC"], flag: null },
      { names: ["Platelets"], flag: null },
      { names: ["Fasting glucose"], flag: "HIGH" },
    ]);
  });
});

describe("flagMismatch", () => {
  const tests = testsFromTranscription(sheet);

  it("rejects an unflagged value described as high (seen live from jina-vlm)", () => {
    const summary =
      "The patient's white blood cell count is high at 7.2. The WBC count is above the reference range of 4.0-11.0.";
    expect(flagMismatch(summary, tests)).toContain("WBC");
  });

  it("recognises the test under the name prose uses for it", () => {
    // Live: "Their white blood cell count is also high" for an unflagged WBC line.
    expect(
      flagMismatch(
        "Their white blood cell count is also high, which means it is working harder.",
        tests,
      ),
    ).toContain("WBC");
    expect(flagMismatch("The platelet count is high.", tests)).toContain("Platelets");
  });

  it("rejects a flagged value described as normal", () => {
    expect(flagMismatch("Haemoglobin is within the normal range.", tests)).toContain("LOW");
  });

  it("accepts a summary that matches the document's flags", () => {
    const summary =
      "This is a blood test report. Haemoglobin is flagged low and fasting glucose is flagged high, while WBC and platelets are within their reference ranges.";
    expect(flagMismatch(summary, tests)).toBeNull();
  });

  it("judges each clause separately", () => {
    expect(flagMismatch("Haemoglobin is low and platelets are normal.", tests)).toBeNull();
  });
});
