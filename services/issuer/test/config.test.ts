import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_OFAC_SOURCES, loadConfig, redactConfig } from "../src/config.js";
import { TEST_ISSUER_PRIVATE_KEY } from "./support.js";

const minimal = { ISSUER_PRIVATE_KEY: TEST_ISSUER_PRIVATE_KEY };

describe("loading configuration", () => {
  it("requires a signing key, and fails at startup rather than on the first request", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ISSUER_PRIVATE_KEY: "   " })).toThrow(ConfigError);
  });

  it("requires the signing key to be a field element", () => {
    expect(() => loadConfig({ ISSUER_PRIVATE_KEY: "hunter2" })).toThrow(/field element/);
  });

  it("defaults to the two Treasury lists", () => {
    expect(loadConfig(minimal).ofacSources).toEqual([...DEFAULT_OFAC_SOURCES]);
  });

  it("defaults the freshness limit to a day", () => {
    expect(loadConfig(minimal).ofacMaxAgeSeconds).toBe(86_400);
  });

  it("normalises the issuer id from a short string", () => {
    expect(loadConfig({ ...minimal, ISSUER_ID: "CORDON_KYC" }).issuerId).toBe(
      "0x434f52444f4e5f4b5943",
    );
  });

  it("reads a comma-separated source list", () => {
    expect(
      loadConfig({ ...minimal, OFAC_SOURCES: " https://a.test/x.xml , https://b.test/y.xml " })
        .ofacSources,
    ).toEqual(["https://a.test/x.xml", "https://b.test/y.xml"]);
  });

  it("refuses a nonsense numeric setting instead of silently using a default", () => {
    expect(() => loadConfig({ ...minimal, PORT: "eighty" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimal, OFAC_MAX_AGE_SECONDS: "0" })).toThrow(ConfigError);
  });
});

describe("what gets logged", () => {
  it("does not carry the signing key at all", () => {
    const config = loadConfig({ ...minimal, ISSUER_ADMIN_TOKEN: "s3cret" });
    const redacted = JSON.stringify(redactConfig(config));

    expect(redacted).not.toContain(TEST_ISSUER_PRIVATE_KEY);
    expect(redacted).not.toContain(TEST_ISSUER_PRIVATE_KEY.slice(2, 20));
    expect(redacted).not.toContain("s3cret");
    expect(Object.keys(redactConfig(config))).not.toContain("issuerPrivateKey");
  });

  it("still says whether an admin token is set, which an operator needs to know", () => {
    expect(redactConfig(loadConfig(minimal))["adminTokenSet"]).toBe(false);
    expect(
      redactConfig(loadConfig({ ...minimal, ISSUER_ADMIN_TOKEN: "x" }))["adminTokenSet"],
    ).toBe(true);
  });
});
