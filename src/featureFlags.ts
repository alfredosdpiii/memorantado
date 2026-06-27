export type FeatureFlagName = "enableMetricsEndpoint";

type FeatureFlag = {
  name: FeatureFlagName;
  env: string;
  defaultEnabled: boolean;
};

const FEATURE_FLAGS: FeatureFlag[] = [
  {
    name: "enableMetricsEndpoint",
    env: "MEMORANTADO_ENABLE_METRICS",
    defaultEnabled: true,
  },
];

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isFeatureEnabled(name: FeatureFlagName): boolean {
  const flag = FEATURE_FLAGS.find((f) => f.name === name);
  if (!flag) return false;
  return parseBoolean(process.env[flag.env], flag.defaultEnabled);
}

export function getFeatureFlags(): FeatureFlag[] {
  return [...FEATURE_FLAGS];
}
