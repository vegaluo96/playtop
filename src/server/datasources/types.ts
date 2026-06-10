import { z } from "zod";
import { normalizedOddsSchema } from "../engine/types";

/**
 * 各维度数据快照的归一化 schema。
 * 所有来源（CSV / open-meteo / AI 检索 / 手动录入）都必须先归一到这里
 * 才能入库 data_snapshots——引擎与报告只认这些结构。
 */

export const oddsPayloadSchema = normalizedOddsSchema;

export const injuriesPayloadSchema = z.object({
  items: z.array(
    z.object({
      team: z.enum(["home", "away"]),
      player: z.string(),
      role: z.enum(["goalkeeper", "defender", "midfielder", "attacker", "unknown"]).default("unknown"),
      importance: z.enum(["key", "regular", "fringe"]).default("regular"),
      status: z.string().default(""),
      note: z.string().optional(),
    }),
  ),
});

export const suspensionsPayloadSchema = injuriesPayloadSchema;

export const lineupsPayloadSchema = z.object({
  confirmed: z.boolean().default(false),
  home: z.object({ formation: z.string().optional(), starters: z.array(z.string()).default([]) }),
  away: z.object({ formation: z.string().optional(), starters: z.array(z.string()).default([]) }),
  note: z.string().optional(),
});

export const h2hPayloadSchema = z.object({
  matches: z.array(
    z.object({
      playedAt: z.number(),
      homeTeam: z.string(),
      awayTeam: z.string(),
      homeGoals: z.number(),
      awayGoals: z.number(),
      competition: z.string().optional(),
    }),
  ),
  summary: z.object({
    total: z.number(),
    homeWins: z.number(),
    draws: z.number(),
    awayWins: z.number(),
  }),
});

export const formPayloadSchema = z.object({
  home: z.object({
    recent: z.array(
      z.object({
        playedAt: z.number(),
        opponent: z.string(),
        venue: z.enum(["home", "away", "neutral"]),
        goalsFor: z.number(),
        goalsAgainst: z.number(),
        shots: z.number().optional(),
        shotsOnTarget: z.number().optional(),
      }),
    ),
    summaryText: z.string(),
  }),
  away: z.object({
    recent: z.array(
      z.object({
        playedAt: z.number(),
        opponent: z.string(),
        venue: z.enum(["home", "away", "neutral"]),
        goalsFor: z.number(),
        goalsAgainst: z.number(),
        shots: z.number().optional(),
        shotsOnTarget: z.number().optional(),
      }),
    ),
    summaryText: z.string(),
  }),
});

export const teamStatsPayloadSchema = z.object({
  home: z.object({
    matches: z.number(),
    gfPerGame: z.number(),
    gaPerGame: z.number(),
    cleanSheetRate: z.number(),
    homeGfPerGame: z.number().nullable(),
    homeGaPerGame: z.number().nullable(),
  }),
  away: z.object({
    matches: z.number(),
    gfPerGame: z.number(),
    gaPerGame: z.number(),
    cleanSheetRate: z.number(),
    awayGfPerGame: z.number().nullable(),
    awayGaPerGame: z.number().nullable(),
  }),
});

export const standingsPayloadSchema = z.object({
  table: z.array(
    z.object({
      rank: z.number(),
      team: z.string(),
      played: z.number(),
      points: z.number(),
      gd: z.number(),
    }),
  ),
  homeRank: z.number().nullable(),
  awayRank: z.number().nullable(),
  note: z.string().optional(),
});

export const playerStatsPayloadSchema = z.object({
  items: z.array(
    z.object({
      team: z.enum(["home", "away"]),
      player: z.string(),
      role: z.enum(["goalkeeper", "defender", "midfielder", "attacker", "unknown"]).default("unknown"),
      goals: z.number().optional(),
      assists: z.number().optional(),
      note: z.string().optional(),
    }),
  ),
});

export const coachPayloadSchema = z.object({
  home: z.object({ name: z.string().default(""), note: z.string().default("") }),
  away: z.object({ name: z.string().default(""), note: z.string().default("") }),
});

export const venuePayloadSchema = z.object({
  name: z.string().default(""),
  city: z.string().default(""),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  capacity: z.number().nullable().optional(),
  surface: z.string().optional(),
});

export const weatherPayloadSchema = z.object({
  temperatureC: z.number().nullable(),
  precipitationMmH: z.number().nullable(),
  windKmH: z.number().nullable(),
  summary: z.string().default(""),
  forecastAt: z.number(),
});

export const refereePayloadSchema = z.object({
  name: z.string().default(""),
  note: z.string().default(""),
});

export const softInfoPayloadSchema = z.object({
  items: z.array(
    z.object({
      topic: z.string(),
      content: z.string(),
      sourceHint: z.string().optional(),
    }),
  ),
});

export const PAYLOAD_SCHEMAS = {
  odds: oddsPayloadSchema,
  injuries: injuriesPayloadSchema,
  suspensions: suspensionsPayloadSchema,
  lineups: lineupsPayloadSchema,
  h2h: h2hPayloadSchema,
  form: formPayloadSchema,
  team_stats: teamStatsPayloadSchema,
  standings: standingsPayloadSchema,
  player_stats: playerStatsPayloadSchema,
  coach: coachPayloadSchema,
  venue: venuePayloadSchema,
  weather: weatherPayloadSchema,
  referee: refereePayloadSchema,
  soft_info: softInfoPayloadSchema,
  manual_override: z.object({ note: z.string(), lambda: z.number().optional(), mu: z.number().optional() }),
} as const;

export type PayloadKind = keyof typeof PAYLOAD_SCHEMAS;
