/** 赔率归一化与异动判定(设计稿口径:line 正=主让;净水=赔率-1;急变阈值) */
import { describe, expect, it } from "vitest";
import { detectMovement, normalizeOddsItem } from "../../src/server/af/normalize";

function oddsItem() {
  return {
    fixture: { id: 1 },
    bookmakers: [
      {
        id: 8,
        name: "Bet365",
        bets: [
          {
            id: 1,
            name: "Match Winner",
            values: [
              { value: "Home", odd: "1.95" },
              { value: "Draw", odd: "3.60" },
              { value: "Away", odd: "3.70" },
            ],
          },
          {
            id: 4,
            name: "Asian Handicap",
            values: [
              { value: "Home -0.5", odd: "1.95" },
              { value: "Away +0.5", odd: "1.93" },
              { value: "Home -1.5", odd: "2.85" },
              { value: "Away +1.5", odd: "1.40" },
            ],
          },
          {
            id: 5,
            name: "Goals Over/Under",
            values: [
              { value: "Over 2.5", odd: "1.90" },
              { value: "Under 2.5", odd: "1.96" },
              { value: "Over 3.5", odd: "2.90" },
              { value: "Under 3.5", odd: "1.40" },
            ],
          },
        ],
      },
    ],
  };
}

describe("normalizeOddsItem", () => {
  it("抽取三市场主盘:亚盘取水位最均衡的 line,符号=主让为正", () => {
    const books = normalizeOddsItem(oddsItem());
    expect(books).toHaveLength(1);
    const ah = books[0].markets.find((m) => m.market === "ah")!;
    expect(ah.line).toBe(0.5); // Home -0.5 → 主让半球
    expect(ah.h).toBeCloseTo(0.95, 2); // 净水 = 1.95 - 1
    expect(ah.a).toBeCloseTo(0.93, 2);
    const ou = books[0].markets.find((m) => m.market === "ou")!;
    expect(ou.line).toBe(2.5);
    expect(ou.h).toBeCloseTo(0.9, 2);
    const eu = books[0].markets.find((m) => m.market === "eu")!;
    expect(eu).toMatchObject({ h: 1.95, d: 3.6, a: 3.7 });
  });

  it("受让盘:Home +0.25 → line = -0.25", () => {
    const item = {
      bookmakers: [
        {
          id: 8,
          name: "Bet365",
          bets: [
            {
              id: 4,
              name: "Asian Handicap",
              values: [
                { value: "Home +0.25", odd: "1.90" },
                { value: "Away -0.25", odd: "1.96" },
              ],
            },
          ],
        },
      ],
    };
    const ah = normalizeOddsItem(item)[0].markets[0];
    expect(ah.line).toBe(-0.25);
  });

  it("缺市场/空书商时安全返回", () => {
    expect(normalizeOddsItem({})).toEqual([]);
    expect(normalizeOddsItem({ bookmakers: [{ id: 1, name: "X", bets: [] }] })).toEqual([]);
  });

  it("赛前总览拦截非法盘口线和极端欧赔", () => {
    const books = normalizeOddsItem({
      bookmakers: [{
        id: 8,
        name: "Bet365",
        bets: [
          { id: 1, name: "Match Winner", values: [
            { value: "Home", odd: "51" }, { value: "Draw", odd: "5" }, { value: "Away", odd: "1.14" },
          ] },
          { id: 4, name: "Asian Handicap", values: [
            { value: "Home -0.3", odd: "1.90" }, { value: "Away +0.3", odd: "1.96" },
          ] },
          { id: 5, name: "Goals Over/Under", values: [
            { value: "Over 9", odd: "1.90" }, { value: "Under 9", odd: "1.96" },
          ] },
        ],
      }],
    });

    expect(books).toEqual([]);
  });

  it("赛前 bet name 映射不依赖 live bet id,仍需经过 value/line 配对", () => {
    const books = normalizeOddsItem({
      bookmakers: [{
        id: 8,
        name: "Bet365",
        bets: [
          { name: "Full Time Result", values: [
            { value: "1", odd: "2.20" }, { value: "X", odd: "3.30" }, { value: "2", odd: "3.40" },
          ] },
          { name: "Spread", values: [
            { value: "Home -0.25", odd: "1.88" }, { value: "Away +0.25", odd: "1.98" },
          ] },
          { name: "Totals", values: [
            { value: "Over 2.25", odd: "1.90" }, { value: "Under 2.25", odd: "1.96" },
          ] },
        ],
      }],
    });

    expect(books[0].markets.find((m) => m.market === "eu")).toMatchObject({ h: 2.2, d: 3.3, a: 3.4 });
    expect(books[0].markets.find((m) => m.market === "ah")).toMatchObject({ line: 0.25 });
    expect(books[0].markets.find((m) => m.market === "ou")).toMatchObject({ line: 2.25 });
  });
});

describe("parseAh 腿标签格式无关(满水率自证)", () => {
  const item = (ahValues: { value: string; odd: string }[], eu?: { h: string; a: string }) => ({
    bookmakers: [{ id: 8, name: "Bet365", bets: [
      ...(eu ? [{ id: 1, name: "Match Winner", values: [
        { value: "Home", odd: eu.h }, { value: "Draw", odd: "3.60" }, { value: "Away", odd: eu.a },
      ] }] : []),
      { id: 4, name: "Asian Handicap", values: ahValues },
    ] }],
  });

  it("镜像标签:Home -0.5 / Away +0.5 → line=+0.5,水位为各自腿", () => {
    const ah = normalizeOddsItem(item([
      { value: "Home -0.5", odd: "1.90" }, { value: "Away +0.5", odd: "1.98" },
    ])).at(0)!.markets.find((m) => m.market === "ah")!;
    expect(ah.line).toBe(0.5);
    expect(ah.h).toBeCloseTo(0.9, 2);
    expect(ah.a).toBeCloseTo(0.98, 2);
  });

  it("同号标签:Home -0.5 / Away -0.5(同一条线的两腿)→ 同样 line=+0.5,不错腿", () => {
    const ah = normalizeOddsItem(item([
      { value: "Home -0.5", odd: "1.90" }, { value: "Away -0.5", odd: "1.98" },
      { value: "Home -1", odd: "2.65" }, { value: "Away -1", odd: "1.48" },
    ])).at(0)!.markets.find((m) => m.market === "ah")!;
    expect(ah.line).toBe(0.5);
    expect(ah.h).toBeCloseTo(0.9, 2);
    expect(ah.a).toBeCloseTo(0.98, 2);
  });

  it("对称梯子歧义:用同书商 1X2 强弱方向裁决(主队热门 → 主让)", () => {
    // 镜像与同号两种假设都能配出满水率合理的对,但 line 符号相反;1X2 主 1.50 vs 客 6.00 → 必须主让
    const ah = normalizeOddsItem(item(
      [
        { value: "Home -0.75", odd: "1.92" }, { value: "Away -0.75", odd: "1.96" },
        { value: "Home +0.75", odd: "1.96" }, { value: "Away +0.75", odd: "1.92" },
      ],
      { h: "1.50", a: "6.00" },
    )).at(0)!.markets.find((m) => m.market === "ah")!;
    expect(ah.line).toBeGreaterThan(0); // 主让,绝不能解析成受让
  });

  it("配错腿/坏数据(满水率失真)整组拒收,不显示假盘", () => {
    const books = normalizeOddsItem(item([
      { value: "Home -0.5", odd: "1.90" }, { value: "Away +0.5", odd: "0.91" }, // 0.91 不是合法欧赔
    ]));
    const ah = books.at(0)?.markets.find((m) => m.market === "ah");
    expect(ah).toBeUndefined();
  });
});

describe("detectMovement(急变 = 盘口位移 ≥0.25 或水位 |Δ|≥0.05)", () => {
  it("升盘:line 上移;0.25 位移即急变", () => {
    const mv = detectMovement("ah", { line: 1.25, h: 0.9, a: 0.96 }, { line: 1.5, h: 0.85, a: 1.01 })!;
    expect(mv.type).toBe("升盘");
    expect(mv.sev).toBe(true);
  });

  it("降盘:line 下移", () => {
    const mv = detectMovement("ou", { line: 3, h: 0.88, a: 0.98 }, { line: 2.75, h: 0.95, a: 0.91 })!;
    expect(mv.type).toBe("降盘");
  });

  it("水位:盘口不变,|Δ|≥0.03 记录;≥0.05 急变", () => {
    expect(detectMovement("ah", { line: 1, h: 0.9, a: 0.96 }, { line: 1, h: 0.92, a: 0.94 })).toBeNull();
    const small = detectMovement("ah", { line: 1, h: 0.9, a: 0.96 }, { line: 1, h: 0.94, a: 0.92 })!;
    expect(small.type).toBe("水位");
    expect(small.sev).toBe(false);
    const big = detectMovement("ah", { line: 1, h: 0.85, a: 1.01 }, { line: 1, h: 0.92, a: 0.94 })!;
    expect(big.sev).toBe(true);
  });
});
