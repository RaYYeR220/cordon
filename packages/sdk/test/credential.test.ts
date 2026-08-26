import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_URI_SCHEME,
  CredentialError,
  createCredential,
  credentialFromCalldata,
  credentialFromJson,
  credentialCalldata,
  credentialToJson,
  credentialUri,
  decodeBase64Url,
  decodeCredential,
  encodeBase64Url,
  encodeCredential,
  issueCredential,
  subjectPublicKey,
  summarizeCredential,
  validateCredential,
} from "../src/index.js";
import { CREDENTIAL_FIXTURE, TEST_ISSUER_PRIVATE_KEY } from "./fixtures.js";

const ISSUER_PUBLIC_KEY = subjectPublicKey(TEST_ISSUER_PRIVATE_KEY);
const credential = issueCredential(CREDENTIAL_FIXTURE, TEST_ISSUER_PRIVATE_KEY);
const BEFORE_EXPIRY = CREDENTIAL_FIXTURE.expiresAt as number;

describe("issuing", () => {
  it("produces a credential whose signature verifies against the issuer key", () => {
    const check = validateCredential(credential, {
      now: BEFORE_EXPIRY - 1,
      issuerPublicKey: ISSUER_PUBLIC_KEY,
      expectedIssuerId: "CORDON_KYC",
      requiredClaim: "ACCREDITED",
      revokedCredentialIds: [],
    });
    expect(check.refusals).toEqual([]);
    expect(check.valid).toBe(true);
    expect(check.skipped).toEqual([]);
  });

  it("normalises every field to canonical hex", () => {
    expect(credential.issuerId).toBe("0x434f52444f4e5f4b5943");
    expect(credential.claim).toBe("0x41434352454449544544");
    expect(credential.expiresAt).toBe(1_800_086_400);
  });

  it("refuses a nonsense expiry rather than truncating it", () => {
    expect(() =>
      createCredential({ ...CREDENTIAL_FIXTURE, expiresAt: 1n << 63n, signature: { r: 1, s: 2 } }),
    ).toThrow(CredentialError);
  });
});

describe("local validation", () => {
  it("names the on-chain refusal for an expired credential", () => {
    const check = validateCredential(credential, { now: BEFORE_EXPIRY + 1 });
    expect(check.refusals.map((refusal) => refusal.code)).toContain("CORDON_EXPIRED");
    expect(check.secondsUntilExpiry).toBe(-1);
  });

  it("names the refusal for a revoked credential", () => {
    const check = validateCredential(credential, {
      now: BEFORE_EXPIRY - 1,
      revokedCredentialIds: ["CRED_0001"],
    });
    expect(check.refusals.map((refusal) => refusal.code)).toContain("CORDON_REVOKED");
  });

  it("names the refusal for the wrong claim", () => {
    const check = validateCredential(credential, {
      now: BEFORE_EXPIRY - 1,
      requiredClaim: "KYC_L2",
    });
    expect(check.refusals.map((refusal) => refusal.code)).toContain("CORDON_CLAIM_MISMATCH");
  });

  it("names the refusal for a forged signature", () => {
    const forged = { ...credential, signature: { r: "0x1", s: "0x2" } };
    const check = validateCredential(forged, {
      now: BEFORE_EXPIRY - 1,
      issuerPublicKey: ISSUER_PUBLIC_KEY,
    });
    expect(check.refusals.map((refusal) => refusal.code)).toContain("CORDON_BAD_CRED");
  });

  it("names the refusal for the wrong issuer", () => {
    const check = validateCredential(credential, {
      now: BEFORE_EXPIRY - 1,
      expectedIssuerId: "OTHER_KYC",
    });
    expect(check.refusals.map((refusal) => refusal.code)).toContain("CORDON_BAD_ISSUER");
  });

  it("reports what it could not check instead of assuming it passed", () => {
    const check = validateCredential(credential, { now: BEFORE_EXPIRY - 1 });
    expect(check.valid).toBe(true);
    expect(check.skipped.length).toBeGreaterThan(0);
    expect(check.skipped.join(" ")).toMatch(/issuer signature/);
  });
});

describe("serialisation", () => {
  it("round-trips through JSON", () => {
    expect(credentialFromJson(JSON.stringify(credentialToJson(credential)))).toEqual(credential);
  });

  it("round-trips through calldata, in the order the Cairo struct declares", () => {
    const calldata = credentialCalldata(credential);
    expect(calldata).toHaveLength(7);
    expect(calldata[0]).toBe(credential.issuerId);
    expect(calldata[5]).toBe(credential.signature.r);
    expect(credentialFromCalldata(calldata)).toEqual(credential);
  });

  it("rejects calldata of the wrong length instead of guessing", () => {
    expect(() => credentialFromCalldata(["0x1", "0x2"])).toThrow(CredentialError);
  });

  it("reports which JSON field is missing", () => {
    expect(() => credentialFromJson({ issuerId: "0x1" })).toThrow(/signature/);
    expect(() => credentialFromJson("{ not json")).toThrow(CredentialError);
  });
});

describe("compact encoding", () => {
  it("round-trips", () => {
    expect(decodeCredential(encodeCredential(credential))).toEqual(credential);
  });

  it("is the same length for every credential, so length leaks nothing", () => {
    const other = issueCredential(
      { ...CREDENTIAL_FIXTURE, credentialId: "C", claim: "KYC_L2", expiresAt: 1 },
      TEST_ISSUER_PRIVATE_KEY,
    );
    expect(encodeCredential(other)).toHaveLength(encodeCredential(credential).length);
  });

  it("is URL-safe and short enough for a QR code", () => {
    const encoded = encodeCredential(credential);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded.length).toBeLessThan(300);
  });

  it("accepts the URI form and a link fragment", () => {
    const uri = credentialUri(credential);
    expect(uri.startsWith(CREDENTIAL_URI_SCHEME)).toBe(true);
    expect(decodeCredential(uri)).toEqual(credential);
    expect(decodeCredential(`https://example.test/passport#c=${encodeCredential(credential)}`))
      .toEqual(credential);
  });

  it("refuses a truncated or corrupted payload rather than returning half a credential", () => {
    const encoded = encodeCredential(credential);
    expect(() => decodeCredential(encoded.slice(0, 40))).toThrow(CredentialError);
    expect(() => decodeCredential("!!!!")).toThrow();
  });

  it("refuses an encoding version it does not understand", () => {
    const bytes = decodeBase64Url(encodeCredential(credential));
    bytes[0] = 9;
    expect(() => decodeCredential(encodeBase64Url(bytes))).toThrow(/version/);
  });
});

describe("base64url", () => {
  it("round-trips every payload length modulo 3", () => {
    for (let length = 0; length < 12; length += 1) {
      const bytes = new Uint8Array(Array.from({ length }, (_, index) => (index * 37) % 256));
      expect([...decodeBase64Url(encodeBase64Url(bytes))]).toEqual([...bytes]);
    }
  });

  it("emits no padding and no URL-unsafe characters", () => {
    const bytes = new Uint8Array([251, 255, 190, 0, 1]);
    expect(encodeBase64Url(bytes)).not.toMatch(/[+/=]/);
  });
});

describe("display", () => {
  it("decodes the readable parts and leaves the pseudonym alone", () => {
    const summary = summarizeCredential(credential, BEFORE_EXPIRY - 1);
    expect(summary).toMatchObject({
      issuer: "CORDON_KYC",
      credentialId: "CRED_0001",
      claim: "ACCREDITED",
      expired: false,
    });
    expect(summary.subject).toBe(credential.subjectPublicKey);
    expect(summary.expiresAt).toBe(new Date(1_800_086_400_000).toISOString());
  });
});
