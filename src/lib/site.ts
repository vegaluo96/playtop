/** 站点主域(裸域 zsky.com;可用 NEXT_PUBLIC_SITE_HOST 覆盖) */
export const SITE_HOST = process.env.NEXT_PUBLIC_SITE_HOST?.trim() || "zsky.com";
export const SITE_BRAND = "ZSKY.COM";
export const SITE_CN_NAME = "足球终端";
export const SITE_TITLE = `${SITE_CN_NAME} · ${SITE_BRAND}`;
export const SITE_SLOGAN = "让球指数 · 大小指数 · 胜平负指数 · 专业行情终端";
