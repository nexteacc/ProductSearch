export const collectionPolicy = {
  defaultTarget: 150,
  maxTarget: 500,
  safetyMultiplier: 1.5,
  baseTimeoutMs: 60000,
  hardPlatformTimeoutMs: 20 * 60000,
  processGraceMs: 60000,
  platforms: {
    amazon: {
      expectedPerUnit: 20,
      minUnits: 10,
      hardUnits: 100,
      msPerUnit: 20000,
      noGrowthLimit: 5,
    },
    etsy: {
      expectedPerUnit: 20,
      minUnits: 10,
      hardUnits: 100,
      msPerUnit: 20000,
      noGrowthLimit: 5,
    },
    pinterest: {
      expectedPerUnit: 3,
      minUnits: 50,
      hardUnits: 1000,
      msPerUnit: 6000,
      noGrowthLimit: 5,
    },
  },
};
export function executionBudget(config: {
  platforms: (keyof typeof collectionPolicy.platforms)[];
  targets: Record<keyof typeof collectionPolicy.platforms, number>;
}) {
  const platforms = Object.fromEntries(
    config.platforms.map((p) => {
      const policy = collectionPolicy.platforms[p];
      const units = Math.min(
        policy.hardUnits,
        Math.max(
          policy.minUnits,
          Math.ceil(
            (config.targets[p] / policy.expectedPerUnit) *
              collectionPolicy.safetyMultiplier,
          ),
        ),
      );
      return [
        p,
        {
          units,
          timeoutMs: Math.min(
            collectionPolicy.hardPlatformTimeoutMs,
            collectionPolicy.baseTimeoutMs + units * policy.msPerUnit,
          ),
          noGrowthLimit: policy.noGrowthLimit,
        },
      ];
    }),
  ) as Record<
    keyof typeof collectionPolicy.platforms,
    { units: number; timeoutMs: number; noGrowthLimit: number }
  >;
  return {
    version: "dynamic-budget-v1",
    platforms,
    timeoutMs: config.platforms.reduce(
      (sum, p) => sum + platforms[p].timeoutMs,
      collectionPolicy.processGraceMs,
    ),
  };
}
