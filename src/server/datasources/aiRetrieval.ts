import { z } from "zod";
import { chatCompletion } from "../llm/apiyi";
import {
  coachPayloadSchema,
  injuriesPayloadSchema,
  lineupsPayloadSchema,
  refereePayloadSchema,
  softInfoPayloadSchema,
  suspensionsPayloadSchema,
} from "./types";

/**
 * AI 检索（apiyi）：补充无免 key 结构化源的软维度——伤停/停赛/预计阵容/教练/裁判/软信息。
 * 输出强制 JSON、入快照标 source='llm'，管理员在工作台可见可改后才进引擎；
 * 模型被明确要求"不确定就留空"，宁缺毋滥。
 */

const retrievalSchema = z.object({
  injuries: injuriesPayloadSchema.shape.items.default([]),
  suspensions: suspensionsPayloadSchema.shape.items.default([]),
  lineups: lineupsPayloadSchema.partial().nullable().default(null),
  coach: coachPayloadSchema.partial().nullable().default(null),
  referee: refereePayloadSchema.partial().nullable().default(null),
  softInfo: softInfoPayloadSchema.shape.items.default([]),
});

export interface AiRetrievalResult {
  injuries: z.infer<typeof injuriesPayloadSchema> | null;
  suspensions: z.infer<typeof suspensionsPayloadSchema> | null;
  lineups: z.infer<typeof lineupsPayloadSchema> | null;
  coach: z.infer<typeof coachPayloadSchema> | null;
  referee: z.infer<typeof refereePayloadSchema> | null;
  softInfo: z.infer<typeof softInfoPayloadSchema> | null;
}

const EMPTY_MOCK = JSON.stringify({
  injuries: [],
  suspensions: [],
  lineups: null,
  coach: null,
  referee: null,
  softInfo: [{ topic: "模拟模式", content: "LLM mock 模式下无软信息检索。", sourceHint: "mock" }],
});

export async function aiRetrieveSoftData(match: {
  leagueName: string;
  homeName: string;
  awayName: string;
  kickoffAtIso: string;
  round: string | null;
}): Promise<AiRetrievalResult> {
  const system = [
    "你是体育数据研究机构的情报检索员。请基于你可获得的最新信息（若你的运行环境支持联网检索请充分使用），",
    "整理指定比赛的赛前软信息。【铁律】不确定或无法核实的信息一律留空或不要输出——宁缺毋滥，绝不编造球员名或事件。",
    "所有 note/content 用简体中文。输出 JSON，结构：",
    `{"injuries":[{"team":"home|away","player":"","role":"goalkeeper|defender|midfielder|attacker|unknown","importance":"key|regular|fringe","status":"伤缺/疑似/停赛等","note":""}],`,
    `"suspensions":[同上],"lineups":{"confirmed":false,"home":{"formation":"","starters":[]},"away":{"formation":"","starters":[]},"note":"预计阵容说明"},`,
    `"coach":{"home":{"name":"","note":"近期执教动态"},"away":{"name":"","note":""}},`,
    `"referee":{"name":"","note":""},`,
    `"softInfo":[{"topic":"动机/轮换/舆情/天气场地等","content":"","sourceHint":"信息来源线索"}]}`,
  ].join("\n");
  const user = `比赛：${match.leagueName}${match.round ? ` ${match.round}` : ""}，${match.homeName}（主） vs ${match.awayName}（客），开球时间（UTC）：${match.kickoffAtIso}。请检索并整理赛前情报。`;
  const raw = await chatCompletion({ system, user, json: true, maxTokens: 2200, mock: EMPTY_MOCK });
  const parsed = retrievalSchema.parse(JSON.parse(raw));
  return {
    injuries: parsed.injuries.length ? injuriesPayloadSchema.parse({ items: parsed.injuries }) : null,
    suspensions: parsed.suspensions.length
      ? suspensionsPayloadSchema.parse({ items: parsed.suspensions })
      : null,
    lineups:
      parsed.lineups && (parsed.lineups.home?.starters?.length || parsed.lineups.away?.starters?.length)
        ? lineupsPayloadSchema.parse({
            confirmed: parsed.lineups.confirmed ?? false,
            home: parsed.lineups.home ?? { starters: [] },
            away: parsed.lineups.away ?? { starters: [] },
            note: parsed.lineups.note,
          })
        : null,
    coach:
      parsed.coach && (parsed.coach.home?.name || parsed.coach.away?.name)
        ? coachPayloadSchema.parse({
            home: parsed.coach.home ?? { name: "", note: "" },
            away: parsed.coach.away ?? { name: "", note: "" },
          })
        : null,
    referee: parsed.referee?.name ? refereePayloadSchema.parse(parsed.referee) : null,
    softInfo: parsed.softInfo.length ? softInfoPayloadSchema.parse({ items: parsed.softInfo }) : null,
  };
}
