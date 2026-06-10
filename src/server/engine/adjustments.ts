import type { InjuryItem, WeatherInfo } from "./types";

/**
 * 确定性情境修正层（启发式规则表，无单篇论文背书，故上限收紧、全程留痕、可整层关闭）。
 * 输出对 λ（主队进球率）/ μ（客队进球率）的乘性修正与审计记录。
 */

export interface Adjustment {
  reason: string;
  lambdaFactor: number;
  muFactor: number;
}

const IMPORTANCE_ATTACK: Record<InjuryItem["importance"], number> = {
  key: 0.04,
  regular: 0.02,
  fringe: 0,
};
const IMPORTANCE_DEFENSE: Record<InjuryItem["importance"], number> = {
  key: 0.03,
  regular: 0.015,
  fringe: 0,
};

/** 单队累计修正夹在 [0.88, 1.08]，保证此层不喧宾夺主 */
const FLOOR = 0.88;
const CEIL = 1.08;

export function computeAdjustments(input: {
  injuries?: InjuryItem[];
  weather?: WeatherInfo;
  neutralVenue?: boolean;
}): { adjustments: Adjustment[]; lambdaFactor: number; muFactor: number; gammaNeutral: boolean } {
  const adjustments: Adjustment[] = [];
  let lambdaFactor = 1;
  let muFactor = 1;

  for (const inj of input.injuries ?? []) {
    const isAttackRole = inj.role === "attacker" || inj.role === "midfielder";
    const attackLoss = IMPORTANCE_ATTACK[inj.importance] * (inj.role === "midfielder" ? 0.6 : 1);
    const defenseLoss = IMPORTANCE_DEFENSE[inj.importance];
    if (inj.importance === "fringe") continue;
    if (inj.team === "home") {
      if (isAttackRole) {
        lambdaFactor *= 1 - attackLoss;
        adjustments.push({
          reason: `主队${inj.player}（${roleLabel(inj.role)}/${impLabel(inj.importance)}）缺阵：主队进攻 ×${(1 - attackLoss).toFixed(3)}`,
          lambdaFactor: 1 - attackLoss,
          muFactor: 1,
        });
      } else {
        muFactor *= 1 + defenseLoss;
        adjustments.push({
          reason: `主队${inj.player}（${roleLabel(inj.role)}/${impLabel(inj.importance)}）缺阵：客队进攻 ×${(1 + defenseLoss).toFixed(3)}`,
          lambdaFactor: 1,
          muFactor: 1 + defenseLoss,
        });
      }
    } else {
      if (isAttackRole) {
        muFactor *= 1 - attackLoss;
        adjustments.push({
          reason: `客队${inj.player}（${roleLabel(inj.role)}/${impLabel(inj.importance)}）缺阵：客队进攻 ×${(1 - attackLoss).toFixed(3)}`,
          lambdaFactor: 1,
          muFactor: 1 - attackLoss,
        });
      } else {
        lambdaFactor *= 1 + defenseLoss;
        adjustments.push({
          reason: `客队${inj.player}（${roleLabel(inj.role)}/${impLabel(inj.importance)}）缺阵：主队进攻 ×${(1 + defenseLoss).toFixed(3)}`,
          lambdaFactor: 1 + defenseLoss,
          muFactor: 1,
        });
      }
    }
  }

  // 累计夹紧
  lambdaFactor = Math.min(CEIL, Math.max(FLOOR, lambdaFactor));
  muFactor = Math.min(CEIL, Math.max(FLOOR, muFactor));

  const w = input.weather;
  if (w && ((w.precipitationMmH ?? 0) > 5 || (w.windKmH ?? 0) > 40)) {
    lambdaFactor *= 0.95;
    muFactor *= 0.95;
    adjustments.push({
      reason: `恶劣天气（降水 ${w.precipitationMmH ?? 0}mm/h，风速 ${w.windKmH ?? 0}km/h）：双方进球率 ×0.95`,
      lambdaFactor: 0.95,
      muFactor: 0.95,
    });
  }

  return { adjustments, lambdaFactor, muFactor, gammaNeutral: !!input.neutralVenue };
}

function roleLabel(role: InjuryItem["role"]): string {
  return { goalkeeper: "门将", defender: "后卫", midfielder: "中场", attacker: "前锋", unknown: "未知位置" }[role];
}
function impLabel(imp: InjuryItem["importance"]): string {
  return { key: "核心", regular: "主力", fringe: "边缘" }[imp];
}
