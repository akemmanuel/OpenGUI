import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { toQuestionAnswers } from "../server/services/http-input";

describe("toQuestionAnswers", () => {
  test("preserves OpenCode question answer arrays", () => {
    expect(
      toQuestionAnswers([
        ["20.000-35.000 €"],
        ["Diesel"],
        ["15.000-25.000 km"],
        ["Zuverlässigkeit", "Komfort"],
      ]),
    ).toEqual([
      ["20.000-35.000 €"],
      ["Diesel"],
      ["15.000-25.000 km"],
      ["Zuverlässigkeit", "Komfort"],
    ]);
  });

  test("rejects malformed question answers", () => {
    expect(() => toQuestionAnswers([{ answer: "Diesel" }])).toThrow("answers[0] must be an array");
    expect(() => toQuestionAnswers([["Diesel", 123]])).toThrow("answers[0][1] must be a string");
  });
});
