import { describe, it, expect } from "vitest";
import { detectEmergency } from "./emergency.js";

describe("detectEmergency", () => {
  it("flags chest pain before any model call", () => {
    const r = detectEmergency("I have chest pain and it hurts when I breathe.");
    expect(r.isEmergency).toBe(true);
    expect(r.advice).toMatch(/chest/i);
  });

  it("flags breathing difficulty", () => {
    expect(detectEmergency("I can't breathe properly.").isEmergency).toBe(true);
    expect(detectEmergency("shortness of breath for an hour").isEmergency).toBe(true);
  });

  it("flags suicidal ideation", () => {
    const r = detectEmergency("I have been feeling suicidal lately.");
    expect(r.isEmergency).toBe(true);
  });

  it("flags stroke symptoms", () => {
    expect(detectEmergency("slurred speech and left arm weakness").isEmergency).toBe(true);
  });

  it("flags anaphylaxis signs", () => {
    expect(detectEmergency("swelling of the throat after the injection").isEmergency).toBe(true);
  });

  it("does not false-positive on ordinary symptoms", () => {
    const r = detectEmergency("I have had a mild headache and a sore throat for two days.");
    expect(r.isEmergency).toBe(false);
    expect(r.advice).toBeUndefined();
  });

  it("does not false-positive on 'chest' alone", () => {
    expect(detectEmergency("Chest X-ray ordered for follow-up").isEmergency).toBe(false);
  });

  it("handles empty input", () => {
    expect(detectEmergency("").isEmergency).toBe(false);
  });

  // Every phrasing below was missed by the previous detector and is a sentence a
  // real patient types. Each one must short-circuit the model.
  it.each([
    "I think I am having a heart attack",
    "my chest hurts really badly",
    "crushing pain in my chest",
    "pressure in my chest spreading to my left arm",
    "I took an overdose of my pills",
    "I took all my sleeping pills",
    "my child swallowed bleach",
    "I want to die",
    "I don't want to live anymore",
    "I keep cutting myself",
    "sudden worst headache of my life",
    "my face is drooping on one side",
    "baby is not breathing",
    "my dad collapsed and is unresponsive",
    "I can’t breathe", // curly apostrophe from a phone keyboard
    "coughing up blood since morning",
    "she is having a seizure",
    "my tongue is swelling after the injection",
    "pregnant and bleeding heavily",
    "he was hit by a car",
    "mujhe dil ka daura lag raha hai",
    "سینے میں درد ہو رہا ہے",
  ])("flags red-flag phrasing: %s", (text) => {
    expect(detectEmergency(text).isEmergency).toBe(true);
  });

  it.each([
    "I have had a mild rash on my arm for three days",
    "knee pain after running",
    "sore throat and a runny nose",
    "I need a refill of my blood pressure medicine",
    "mild headache in the evenings",
    "follow-up for my diabetes check",
    "my back hurts when I sit too long",
  ])("does not flag a routine complaint: %s", (text) => {
    expect(detectEmergency(text).isEmergency).toBe(false);
  });
});
