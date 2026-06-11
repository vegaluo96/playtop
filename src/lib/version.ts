/** 构建时从 package.json 注入(next.config env);发版改 package.json version 即全站同步 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
