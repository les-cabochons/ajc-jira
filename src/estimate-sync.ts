// This policy is bundled with the connector so the installed plugin has no host-code dependency.
export interface ResolveEstimateSyncActionInput {
  localValue?: number;
  remoteValue?: number;
  baselineValue?: number;
  resolution?: "keep_local";
}

export type ResolveEstimateSyncActionResult =
  | {
      status: "noop";
      localValue?: number;
      remoteValue?: number;
      baselineValue?: number;
      nextBaselineValue?: number;
    }
  | {
      status: "push" | "pull";
      localValue?: number;
      remoteValue?: number;
      baselineValue?: number;
      nextBaselineValue?: number;
    }
  | {
      status: "conflict";
      localValue?: number;
      remoteValue?: number;
      baselineValue?: number;
    };

export function resolveEstimateSyncAction(
  input: ResolveEstimateSyncActionInput,
): ResolveEstimateSyncActionResult {
  const localChanged = input.localValue !== input.baselineValue;
  const remoteChanged = input.remoteValue !== input.baselineValue;

  if (input.resolution === "keep_local") {
    return {
      status: "push",
      localValue: input.localValue,
      remoteValue: input.remoteValue,
      baselineValue: input.baselineValue,
      nextBaselineValue: input.localValue,
    };
  }

  if (localChanged && remoteChanged) {
    return {
      status: "conflict",
      localValue: input.localValue,
      remoteValue: input.remoteValue,
      baselineValue: input.baselineValue,
    };
  }

  if (localChanged) {
    return {
      status: "push",
      localValue: input.localValue,
      remoteValue: input.remoteValue,
      baselineValue: input.baselineValue,
      nextBaselineValue: input.localValue,
    };
  }

  if (remoteChanged) {
    return {
      status: "pull",
      localValue: input.localValue,
      remoteValue: input.remoteValue,
      baselineValue: input.baselineValue,
      nextBaselineValue: input.remoteValue,
    };
  }

  return {
    status: "noop",
    localValue: input.localValue,
    remoteValue: input.remoteValue,
    baselineValue: input.baselineValue,
    nextBaselineValue: input.baselineValue,
  };
}
