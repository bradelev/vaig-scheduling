import { describe, expect, it } from "vitest";
import { isPackageItem, packageRemaining, remainingLabel } from "./packages";

describe("packages — pure helpers", () => {
  it("remaining never goes negative", () => {
    expect(packageRemaining({ total: 6, used: 2 })).toBe(4);
    expect(packageRemaining({ total: 6, used: 6 })).toBe(0);
    expect(packageRemaining({ total: 6, used: 9 })).toBe(0);
  });
  it("labels agree in number", () => {
    expect(remainingLabel({ total: 6, used: 2 })).toBe("te quedan 4 de 6");
    expect(remainingLabel({ total: 6, used: 5 })).toBe("te queda 1 de 6");
    expect(remainingLabel({ total: 6, used: 6 })).toBe("no te quedan sesiones de 6");
  });
  it("a package item has at least 2 sessions", () => {
    expect(isPackageItem(6)).toBe(true);
    expect(isPackageItem(1)).toBe(false);
    expect(isPackageItem(null)).toBe(false);
    expect(isPackageItem(undefined)).toBe(false);
  });
});
