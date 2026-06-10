"use client";

import { useEffect, useState } from "react";
import { api, fmtTs } from "@/components/admin/api";
import { Tag } from "@/components/ui";

interface UserRow {
  id: number;
  username: string;
  role: string;
  points: number;
  status: string;
  createdAt: number;
}

export default function AdminUsers() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [delta, setDelta] = useState<Record<number, string>>({});
  const [note, setNote] = useState<Record<number, string>>({});

  const load = (query = "") =>
    api<UserRow[]>(`/api/admin/users${query ? `?q=${encodeURIComponent(query)}` : ""}`)
      .then(setRows)
      .catch((e) => setMsg(e.message));
  useEffect(() => {
    void load();
  }, []);

  async function adjust(userId: number) {
    const d = Number(delta[userId]);
    if (!Number.isInteger(d) || d === 0) {
      setMsg("请输入非零整数变动值（正=充值，负=扣减）");
      return;
    }
    try {
      const r = await api<{ balanceAfter: number }>(`/api/admin/users/${userId}/points`, {
        method: "POST",
        body: JSON.stringify({ delta: d, note: note[userId] || undefined }),
      });
      setMsg(`✓ 用户 #${userId} 余额 → ${r.balanceAfter}`);
      setDelta({ ...delta, [userId]: "" });
      void load(q);
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : e}`);
    }
  }

  async function setStatus(userId: number, status: "active" | "banned") {
    try {
      await api(`/api/admin/users/${userId}`, { method: "PUT", body: JSON.stringify({ status }) });
      void load(q);
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div>
      <h1 className="font-display text-lg tracking-wider">用户与积分</h1>
      <p className="mt-1 text-[12px] text-faint">积分只能在这里人工添加（线下收款后操作），所有变动写入不可变流水与审计日志。</p>
      <div className="mt-3 flex gap-2">
        <input
          placeholder="搜索用户名"
          className="rounded border border-hairline bg-overlay/50 px-3 py-1.5 text-[13px]"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load(q)}
        />
        <button onClick={() => void load(q)} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">
          搜索
        </button>
      </div>
      {msg && <p className="mt-2 rounded border border-hairline bg-surface px-3 py-2 text-[12px] text-muted">{msg}</p>}

      <div className="mt-4 overflow-x-auto">
      <table className="tabular w-full min-w-[720px] text-[12.5px]">
        <thead>
          <tr className="text-left text-[10px] tracking-wider text-faint">
            <th className="pb-2 font-normal">ID</th>
            <th className="pb-2 font-normal">用户名</th>
            <th className="pb-2 font-normal">角色</th>
            <th className="pb-2 text-right font-normal">余额</th>
            <th className="pb-2 font-normal">状态</th>
            <th className="pb-2 font-normal">注册时间</th>
            <th className="pb-2 font-normal">积分操作</th>
            <th className="pb-2 font-normal" />
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} className="border-t border-hairline">
              <td className="py-2 text-faint">#{u.id}</td>
              <td className="py-2">{u.username}</td>
              <td className="py-2 text-muted">{u.role}</td>
              <td className="py-2 text-right text-gold-bright">{u.points}</td>
              <td className="py-2">{u.status === "active" ? <Tag tone="up">正常</Tag> : <Tag tone="down">已禁用</Tag>}</td>
              <td className="py-2 text-faint">{fmtTs(u.createdAt)}</td>
              <td className="py-2">
                <div className="flex gap-1.5">
                  <input
                    placeholder="±积分"
                    className="w-20 rounded border border-hairline bg-overlay/50 px-2 py-1 text-[12px]"
                    value={delta[u.id] ?? ""}
                    onChange={(e) => setDelta({ ...delta, [u.id]: e.target.value })}
                  />
                  <input
                    placeholder="备注"
                    className="w-28 rounded border border-hairline bg-overlay/50 px-2 py-1 text-[12px]"
                    value={note[u.id] ?? ""}
                    onChange={(e) => setNote({ ...note, [u.id]: e.target.value })}
                  />
                  <button onClick={() => void adjust(u.id)} className="rounded border border-gold/50 px-2 py-1 text-[11px] text-gold-bright">
                    执行
                  </button>
                </div>
              </td>
              <td className="py-2 text-right">
                {u.role !== "admin" &&
                  (u.status === "active" ? (
                    <button onClick={() => void setStatus(u.id, "banned")} className="text-[11px] text-down underline underline-offset-2">
                      禁用
                    </button>
                  ) : (
                    <button onClick={() => void setStatus(u.id, "active")} className="text-[11px] text-up underline underline-offset-2">
                      解禁
                    </button>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
