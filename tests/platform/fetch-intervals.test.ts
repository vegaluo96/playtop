import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { kvSet } from "../../src/server/af/store";
import { _resetDbForTest } from "../../src/server/db";
import { cfgEffectiveTierIntervals, cfgEmergencyThrottleState, cfgSet, cfgTierIntervals } from "../../src/server/platform/config";

beforeEach(() => _resetDbForTest());

describe("AF fetch interval throttling", () => {
  it("keeps configured intervals when neither manual nor quota throttle is active", () => {
    expect(cfgEmergencyThrottleState()).toMatchObject({ manual: false, auto: false, active: false, pct: null });
    expect(cfgEffectiveTierIntervals()).toEqual(cfgTierIntervals());
  });

  it("doubles all intervals when manual emergency throttle is on", () => {
    cfgSet("emergency_throttle", 1);
    const base = cfgTierIntervals();
    const effective = cfgEffectiveTierIntervals();

    expect(cfgEmergencyThrottleState()).toMatchObject({ manual: true, auto: false, active: true });
    expect(effective).toEqual(base.map((ms) => ms * 2));
  });

  it("warns at 85% quota usage without auto-throttling", () => {
    kvSet("af_status", JSON.stringify({ current: 86, limit: 100 }));
    const base = cfgTierIntervals();
    const state = cfgEmergencyThrottleState();

    expect(state).toMatchObject({ manual: false, auto: false, active: false, pct: 86 });
    expect(cfgEffectiveTierIntervals()).toEqual(base);
  });

  it("auto-throttles when AF daily quota usage reaches 95%", () => {
    kvSet("af_status", JSON.stringify({ current: 95, limit: 100 }));
    const base = cfgTierIntervals();
    const state = cfgEmergencyThrottleState();

    expect(state).toMatchObject({ manual: false, auto: true, active: true, pct: 95 });
    expect(cfgEffectiveTierIntervals()).toEqual(base.map((ms) => ms * 2));
  });
});
