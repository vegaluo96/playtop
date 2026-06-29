import { DcView } from "./dc/DcView";
import { useMiCall } from "./logic/useMiCall";
import { useGestures } from "./logic/useGestures";
import type { MiCallProps } from "./logic/MiCallLogic";
import template from "./app.template.html?raw";

// Default editor props from the prototype's data-props (theme/orbColor/aiName).
const DEFAULT_PROPS: MiCallProps = {
  theme: "dark",   // 默认深色（用户未显式选过浅色时）；浅色仍可在设置里切换、并持久化
  orbColor: "#AAB8FF",
  aiName: "VEGAluo",
};

export default function App() {
  const logic = useMiCall(DEFAULT_PROPS);
  useGestures(logic); // 侧栏滑入/滑出、底部弹窗下滑关闭（纯行为层，零视觉改动）
  return <DcView template={template} vals={logic.renderVals()} />;
}
