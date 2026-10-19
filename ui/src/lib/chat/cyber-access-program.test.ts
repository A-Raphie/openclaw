import { describe, expect, it } from "vitest";
import { readResponseAccessProgram } from "./cyber-access-program.ts";

const response = {
  role: "assistant",
  provider: "openai",
  model: "gpt-5.4",
  responseAccessProgram: "daybreak_blue",
};
describe("provider-reported access program", () => {
  it("requires matching provider/model assistant response evidence, not request metadata", () => {
    expect(readResponseAccessProgram([response], "openai/gpt-5.4")).toBe("daybreak_blue");
    expect(readResponseAccessProgram([response], "openai/other")).toBeUndefined();
    expect(readResponseAccessProgram([response], "other/gpt-5.4")).toBeUndefined();
    expect(
      readResponseAccessProgram([{ ...response, role: "user" }], "openai/gpt-5.4"),
    ).toBeUndefined();
    expect(
      readResponseAccessProgram(
        [{ ...response, responseAccessProgram: undefined, cyberAccessProgram: "daybreak_red" }],
        "openai/gpt-5.4",
      ),
    ).toBeUndefined();
  });
  it.each([undefined, null, "not-a-program"])(
    "does not reuse older confirmation when the latest response reports %s",
    (reported) => {
      expect(
        readResponseAccessProgram(
          [response, { ...response, responseAccessProgram: reported }],
          "openai/gpt-5.4",
        ),
      ).toBeUndefined();
    },
  );
});
