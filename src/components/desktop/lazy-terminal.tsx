"use client";

import dynamic from "next/dynamic";
import type { DTab } from "./terminal";

type TerminalProps = {
  initialMatchId?: number;
  initialTab?: DTab;
  initialDrawer?: boolean;
};

const TerminalClient = dynamic<TerminalProps>(() => import("./terminal").then((mod) => mod.Terminal), {
  ssr: false,
  loading: () => null,
});

export function LazyTerminal(props: TerminalProps) {
  return <TerminalClient {...props} />;
}
