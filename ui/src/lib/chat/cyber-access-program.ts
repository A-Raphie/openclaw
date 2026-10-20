import type { CyberAccessProgram } from "../../api/types.ts";

export function isCyberAccessProgram(value: unknown): value is CyberAccessProgram {
  return value === "standard" || value === "daybreak_blue" || value === "daybreak_red";
}
