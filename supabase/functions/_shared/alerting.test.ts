import { assertEquals } from "jsr:@std/assert@1";
import { templateParam, transitionAlert } from "./alerting.ts";

Deno.test("first failure alerts (no history)", () => {
  assertEquals(transitionAlert(null, false), "fail");
});

Deno.test("ok → fail alerts", () => {
  assertEquals(transitionAlert(true, false), "fail");
});

Deno.test("staying broken stays silent", () => {
  assertEquals(transitionAlert(false, false), null);
});

Deno.test("fail → ok sends a recovery notice", () => {
  assertEquals(transitionAlert(false, true), "recovery");
});

Deno.test("steady ok stays silent (incl. first-ever ok)", () => {
  assertEquals(transitionAlert(true, true), null);
  assertEquals(transitionAlert(null, true), null);
});

Deno.test("templateParam collapses whitespace, redacts digits, caps length", () => {
  assertEquals(
    templateParam("fetch failed:\n  HTTP 500\tfor +59891234567"),
    "fetch failed: HTTP 500 for +***4567",
  );
  assertEquals(templateParam("x".repeat(300)).length, 200);
});
