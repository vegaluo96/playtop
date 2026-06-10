import { handleRoute, jsonOk } from "@/server/lib/api";
import { v2TrackRecords } from "@/server/v2/read";

/** V2：长期战绩（物化表，按 scope 维度） */
export async function GET() {
  return handleRoute(async () => jsonOk(v2TrackRecords()));
}
