// Invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendLoginCode } from "./whatsapp";

describe("sendLoginCode", () => {
  beforeEach(() => {
    vi.stubEnv("WHATSAPP_TOKEN", "test-token");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "123456");
    vi.stubEnv("CLIENT_AUTH_TEST_MODE", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends the body AND the copy-code button parameter (Meta auth template)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await sendLoginCode("+59891234567", "123456");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(String(url)).toContain("/123456/messages");
    const body = JSON.parse(init.body) as {
      to: string;
      template: { name: string; language: { code: string }; components: unknown };
    };
    expect(body.to).toBe("59891234567"); // no leading '+'
    expect(body.template.name).toBe("codigo_login");
    expect(body.template.language.code).toBe("es_UY");
    // An AUTHENTICATION template send MUST carry both parameters — body-only
    // is rejected by Graph (the "No se pudo enviar el código" regression).
    expect(body.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "123456" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] },
    ]);
  });

  it("throws on a Meta error without the code or full phone in the message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await expect(sendLoginCode("+59891234567", "654321")).rejects.toThrow("HTTP 400");
    await expect(sendLoginCode("+59891234567", "654321")).rejects.not.toThrow(/654321|91234567/);
  });

  it("stub mode (CLIENT_AUTH_TEST_MODE=1) never hits Meta", async () => {
    vi.stubEnv("CLIENT_AUTH_TEST_MODE", "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await sendLoginCode("+59891234567", "123456");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
  });
});
