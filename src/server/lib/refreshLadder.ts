/**
 * 盘口刷新阶梯（单一事实来源，前后端共享）：
 * >12h 静默（仅首采）→ 12h~30min 每 30 分钟（主循环）
 * → 30~10min 每 5 分钟 → 最后 10 分钟每分钟。
 * 服务端 collect/scheduler 与用户端 RefreshLadder 均引用此处，避免边界值漂移。
 */
export const REFRESH_LADDER = {
  /** 盘口静默上界（分钟）：开赛前超过此值不刷盘口 */
  quietMins: 720,
  /** 临场冲刺窗口（分钟）：进入 5 分钟级 / 每分钟级的总窗口 */
  sprintMins: 30,
  /** 最后冲刺（分钟）：每分钟刷新 */
  finalMins: 10,
} as const;

export interface RefreshStage {
  label: string;
  range: string;
  /** 该档位是否为当前距开球分钟数所处区间 */
  match: (mins: number) => boolean;
}

export const REFRESH_STAGES: RefreshStage[] = [
  { label: "盘口静默", range: `开赛前 ${REFRESH_LADDER.quietMins / 60} 小时以上`, match: (m) => m > REFRESH_LADDER.quietMins },
  { label: "每 30 分钟", range: `${REFRESH_LADDER.quietMins / 60} 小时 ~ ${REFRESH_LADDER.sprintMins} 分钟`, match: (m) => m <= REFRESH_LADDER.quietMins && m > REFRESH_LADDER.sprintMins },
  { label: "每 5 分钟", range: `${REFRESH_LADDER.sprintMins} ~ ${REFRESH_LADDER.finalMins} 分钟`, match: (m) => m <= REFRESH_LADDER.sprintMins && m > REFRESH_LADDER.finalMins },
  { label: "每分钟", range: `最后 ${REFRESH_LADDER.finalMins} 分钟`, match: (m) => m <= REFRESH_LADDER.finalMins },
];
