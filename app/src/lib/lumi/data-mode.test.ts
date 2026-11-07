import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLumiPreviewEnabled } from "./preview-flag";
import { lumiDataMode } from "./data-mode";

describe("Dong-Lumi data mode (real data must never be reachable without login)", () => {
  it("off by default; preview only with the flag and never against the production URL", () => {
    assert.equal(lumiDataMode({}), "off");
    assert.equal(lumiDataMode({ DONGLUMI_PREVIEW: "1" }), "preview");
    assert.equal(lumiDataMode({ DONGLUMI_PREVIEW: "1", NEXTAUTH_URL: "https://app.dongchannel.com" }), "off");
  });
  it("db mode wins over the anonymous preview flag", () => {
    assert.equal(lumiDataMode({ LUMI_DATA: "db", DONGLUMI_PREVIEW: "1" }), "db");
    assert.equal(lumiDataMode({ LUMI_DATA: "db" }), "db");
    assert.equal(lumiDataMode({ LUMI_DATA: "other" }), "off");
  });
  it("the middleware's preview bypass flag is OFF whenever db mode is on", () => {
    const keep = { ...process.env };
    try {
      process.env.DONGLUMI_PREVIEW = "1"; process.env.NEXTAUTH_URL = "http://localhost:3100";
      delete process.env.LUMI_DATA;
      assert.equal(isLumiPreviewEnabled(), true);
      process.env.LUMI_DATA = "db";
      assert.equal(isLumiPreviewEnabled(), false);
    } finally { process.env = keep; }
  });
});
