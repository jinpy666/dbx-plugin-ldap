import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitEntryChanged,
  emitEntryDeleted,
  emitEntryEvent,
  emitEntryMoved,
  onEntryEvent,
  resetEntryEvents,
  type EntryEvent,
} from "./entryEvents";

afterEach(() => resetEntryEvents());

describe("entryEvents bus", () => {
  it("delivers emitted events to subscribers with the exact payload", () => {
    const seen: EntryEvent[] = [];
    onEntryEvent((event) => seen.push(event));
    emitEntryEvent({ kind: "changed", connectionId: "c1", dn: "uid=a,dc=x" });
    expect(seen).toEqual([{ kind: "changed", connectionId: "c1", dn: "uid=a,dc=x" }]);
  });

  it("notifies every subscriber and keeps subscription order", () => {
    const order: string[] = [];
    const off = onEntryEvent(() => order.push("first"));
    onEntryEvent(() => order.push("second"));
    emitEntryChanged("c1", "uid=a,dc=x");
    expect(order).toEqual(["first", "second"]);
    off();
    emitEntryChanged("c1", "uid=b,dc=x");
    expect(order).toEqual(["first", "second", "second"]);
  });

  it("carries previousDn and descendants on moved/deleted helpers", () => {
    const seen: EntryEvent[] = [];
    onEntryEvent((event) => seen.push(event));
    emitEntryDeleted("c1", "ou=people,dc=x", true);
    emitEntryMoved("c1", "uid=a,ou=people,dc=x", "uid=a,ou=people2,dc=x", false);
    expect(seen[0]).toMatchObject({ kind: "deleted", dn: "ou=people,dc=x", descendants: true });
    expect(seen[1]).toMatchObject({ kind: "moved", previousDn: "uid=a,ou=people,dc=x", dn: "uid=a,ou=people2,dc=x", descendants: false });
  });

  it("stops delivering after reset (test isolation)", () => {
    const seen: EntryEvent[] = [];
    onEntryEvent((event) => seen.push(event));
    resetEntryEvents();
    emitEntryChanged("c1", "uid=a,dc=x");
    expect(seen).toHaveLength(0);
  });

  it("keeps listener exceptions from breaking other listeners", () => {
    const spy = vi.fn();
    onEntryEvent(() => {
      throw new Error("boom");
    });
    onEntryEvent(spy);
    expect(() => emitEntryChanged("c1", "uid=a,dc=x")).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
