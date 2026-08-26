import { describe, expect, it } from "vitest";
import { OfacParseError, parseOfacList } from "../src/ofac/parse.js";
import { fixtureXml } from "./support.js";

const xml = await fixtureXml();
const parsed = parseOfacList(xml);

describe("parsing an OFAC list", () => {
  it("reads the publication metadata OFAC prints in the file", () => {
    expect(parsed.publishDate).toBe("01/15/2026");
    expect(parsed.recordCount).toBe(4);
    expect(parsed.entryCount).toBe(4);
  });

  it("finds every digital-currency address and nothing else", () => {
    expect(parsed.addresses.map((listing) => listing.asset).sort()).toEqual([
      "ETH",
      "STRK",
      "TRX",
      "XBT",
    ]);
  });

  it("ignores identifiers that are not addresses", () => {
    const numbers = parsed.addresses.map((listing) => listing.address);
    expect(numbers).not.toContain("Male");
    expect(numbers).not.toContain("nobody@example.invalid");
    expect(numbers).not.toContain("IMO 0000000");
  });

  it("skips an address element with no address in it", () => {
    expect(parsed.addresses.filter((listing) => listing.address.trim() === "")).toEqual([]);
  });

  it("keeps the listing context a refusal needs to be meaningful", () => {
    const listing = parsed.addresses.find((entry) => entry.asset === "ETH");
    expect(listing).toMatchObject({
      address: "0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333",
      name: "Pat EXAMPLE-PERSON",
      entryUid: "10002",
      idUid: "20003",
      type: "Individual",
    });
    expect(listing?.programs).toEqual(["CYBER2", "DPRK3"]);
  });

  it("keeps the address exactly as published, case intact", () => {
    expect(parsed.addresses.map((listing) => listing.address)).toContain(
      "0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333",
    );
  });

  it("handles an entry with one program and an entity name", () => {
    const listing = parsed.addresses.find((entry) => entry.asset === "TRX");
    expect(listing?.name).toBe("EXAMPLE MIXER");
    expect(listing?.programs).toEqual(["CYBER2"]);
  });

  it("refuses a document that is not a sanctions list", () => {
    // An error page served with a 200 is the dangerous case: it parses as XML and contains no
    // addresses, which is indistinguishable from a clean list unless it is rejected outright.
    expect(() => parseOfacList("<html><body>Service Unavailable</body></html>")).toThrow(
      OfacParseError,
    );
    expect(() => parseOfacList("")).toThrow(OfacParseError);
  });
});
