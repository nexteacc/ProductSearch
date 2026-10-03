import { judge } from "./jev";
export interface JudgmentEngine {
  id: string;
  requiresKey: boolean;
  judge: typeof judge;
}
export function judgmentEngines(
  jev: typeof judge = judge,
): ReadonlyMap<string, JudgmentEngine> {
  return new Map([["jev", { id: "jev", requiresKey: true, judge: jev }]]);
}
