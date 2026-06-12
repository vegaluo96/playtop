/** 站点主域(裸域 zsky.com;可用 NEXT_PUBLIC_SITE_HOST 覆盖) */
export const SITE_HOST = process.env.NEXT_PUBLIC_SITE_HOST?.trim() || "zsky.com";
export const SITE_BRAND = "ZSKY.COM";
export const SITE_CN_NAME = "足球天空";
export const SITE_TITLE = `${SITE_CN_NAME} · ${SITE_BRAND}`;
export const SITE_SLOGAN = "亚盘 · 大小球 · 胜平负 · 足球数据分析";
