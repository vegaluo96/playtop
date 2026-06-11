/**
 * 语言包(HANDOFF §4:文案走语言包,简中起步,7 语言占位)。
 * 简中为基准字典;其余语言未翻译的键自动回落简中。
 */

export const LANGS = ["简体中文", "繁體中文", "English", "한국어", "日本語", "Tiếng Việt", "ไทย"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "简体中文";

const zh = {
  brandA: "足球",
  brandB: "终端",
  slogan: "亚盘 · 大小球 · 胜平负",
  sloganLong: "亚盘 · 大小球 · 胜平负 · 专业数据",
  navMatches: "赛事",
  navMoves: "异动",
  navPred: "预测",
  navMine: "我",
  refreshRule: "⟳ 数据刷新规则 ›",
  colVs: "对阵",
  colAh: "亚盘",
  colOu: "大小",
  colEu: "胜平负",
  chipLive: "直播",
  chipToday: "今日",
  chipTomorrow: "明日",
  chipAll: "全部",
  noRows: "该时段暂无已开盘赛事",
  homeTag: "主",
  awayTag: "客",
  homeSide: "主场",
  awaySide: "客场",
  moved: "异动",
  maskedTag: "注册可见",
  freeTag: "免费预测",
  unlockedTag: "预测已解锁",
  loginTitle: "邮箱登录 / 注册",
  loginNote: "未注册的邮箱将自动创建账户,无需邮箱验证",
  loginBtn: "登录 / 注册",
  guestBack: "暂不注册,返回浏览 ›",
  emailPh: "邮箱",
  passwordPh: "密码(至少 6 位)",
  giftTitle: "新人礼包",
  giftClaim: "立即领取",
  pts: "积分",
  balance: "积分余额",
  recharge: "充值",
  redeem: "兑换",
  logout: "退出登录",
} as const;

export type DictKey = keyof typeof zh;

/** 其余 6 语言:占位(键不全时回落简中) */
const packs: Partial<Record<Lang, Partial<Record<DictKey, string>>>> = {
  English: {
    navMatches: "Matches",
    navMoves: "Moves",
    navPred: "Predict",
    navMine: "Me",
  },
};

export function t(key: DictKey, lang: Lang = DEFAULT_LANG): string {
  return packs[lang]?.[key] ?? zh[key];
}

export const zhDict = zh;
