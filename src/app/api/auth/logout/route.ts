import { cookies } from "next/headers";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { destroySession, SESSION_COOKIE } from "@/server/auth/session";

export async function POST() {
  return handleRoute(async () => {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) destroySession(token);
    const res = jsonOk({});
    res.cookies.delete(SESSION_COOKIE);
    return res;
  });
}
