/**
 * Note bindings: the strong mode, and how hard the weak one is to reach by accident.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_UNBOUND_WINDOW_SECONDS,
  NOTE_ANY,
  NoteBindingError,
  acceptAnyNoteAndAllowRedirection,
  bindToNote,
  bindingFelt,
  describeBinding,
  fundBinding,
  isUnbound,
  toFelt,
} from "../src/index.js";
import { RESOLVED_NOTE_ID } from "./fixtures.js";

const NOW = 1_800_000_000;

describe("binding to a note", () => {
  it("commits to the resolved id and needs no deadline", () => {
    const binding = bindToNote(RESOLVED_NOTE_ID);
    expect(binding).toEqual({ mode: "note", noteId: toFelt(RESOLVED_NOTE_ID), validUntil: 0 });
    expect(bindingFelt(binding)).toBe(toFelt(RESOLVED_NOTE_ID));
    expect(isUnbound(binding)).toBe(false);
  });

  it("accepts an optional deadline", () => {
    expect(bindToNote(RESOLVED_NOTE_ID, { validUntil: NOW }).validUntil).toBe(NOW);
  });

  it("refuses the NOTE_ANY sentinel, which is not a note id", () => {
    expect(() => bindToNote(NOTE_ANY)).toThrow(NoteBindingError);
    expect(() => bindToNote(NOTE_ANY)).toThrow(/acceptAnyNoteAndAllowRedirection/);
  });

  it("refuses zero, which is the Fund leg's binding and never a real note", () => {
    expect(() => bindToNote(0)).toThrow(/CORDON_NOTE_MISMATCH/);
  });

  it("refuses a negative or fractional deadline", () => {
    expect(() => bindToNote(RESOLVED_NOTE_ID, { validUntil: -1 })).toThrow(NoteBindingError);
    expect(() => bindToNote(RESOLVED_NOTE_ID, { validUntil: 1.5 })).toThrow(NoteBindingError);
  });

  it("describes what it commits to", () => {
    expect(describeBinding(bindToNote(RESOLVED_NOTE_ID))).toContain("Only note");
    expect(describeBinding(fundBinding())).toContain("No note");
  });
});

describe("giving up the binding", () => {
  it("produces the sentinel and reports itself as unbound", () => {
    const binding = acceptAnyNoteAndAllowRedirection({ validUntil: NOW + 300, now: NOW });
    expect(binding).toEqual({ mode: "any-note", validUntil: NOW + 300 });
    expect(bindingFelt(binding)).toBe(NOTE_ANY);
    expect(isUnbound(binding)).toBe(true);
  });

  it("insists on a deadline, as the gate does", () => {
    expect(() =>
      acceptAnyNoteAndAllowRedirection({ validUntil: 0, now: NOW }),
    ).toThrow(/CORDON_NEEDS_DEADLINE/);
  });

  it("refuses a deadline that has already passed", () => {
    expect(() =>
      acceptAnyNoteAndAllowRedirection({ validUntil: NOW - 1, now: NOW }),
    ).toThrow(/CORDON_AUTH_EXPIRED/);
  });

  it("refuses a window longer than the gate allows", () => {
    const tooLong = NOW + MAX_UNBOUND_WINDOW_SECONDS + 1;
    expect(() => acceptAnyNoteAndAllowRedirection({ validUntil: tooLong, now: NOW })).toThrow(
      /CORDON_WINDOW_TOO_LONG/,
    );
    // Exactly at the limit is fine, which is what the gate does too.
    expect(
      acceptAnyNoteAndAllowRedirection({
        validUntil: NOW + MAX_UNBOUND_WINDOW_SECONDS,
        now: NOW,
      }).validUntil,
    ).toBe(NOW + MAX_UNBOUND_WINDOW_SECONDS);
  });

  it("says in its description that the authorisation is redirectable", () => {
    const description = describeBinding(
      acceptAnyNoteAndAllowRedirection({ validUntil: NOW + 60, now: NOW }),
    );
    expect(description).toContain("Any note");
    expect(description).toContain("redirected");
  });

  it("cannot be produced without naming what it gives up", () => {
    // The API has exactly one way in, and its name is the warning. There is no boolean flag, no
    // options bag with a default, and no path that reaches NOTE_ANY without typing this out.
    expect(acceptAnyNoteAndAllowRedirection.name).toBe("acceptAnyNoteAndAllowRedirection");
    expect(acceptAnyNoteAndAllowRedirection.length).toBe(1);
  });
});
