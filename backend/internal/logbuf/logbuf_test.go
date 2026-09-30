package logbuf

import (
	"testing"
)

func TestAppendAssignsMonotonicSeqAndTime(t *testing.T) {
	b := New(4)
	first := b.Append(Entry{Method: "ldap/search", Result: "ok"})
	second := b.Append(Entry{Method: "ldap/search", Result: "error"})
	if first.Seq != 1 || second.Seq != 2 {
		t.Fatalf("seq not monotonic: %d, %d", first.Seq, second.Seq)
	}
	if first.At <= 0 || second.At < first.At {
		t.Fatalf("At not sane: %d then %d", first.At, second.At)
	}
	if b.Len() != 2 {
		t.Fatalf("Len = %d, want 2", b.Len())
	}
}

func TestTailReturnsAllWhenUnderCapacity(t *testing.T) {
	b := New(8)
	for i := 0; i < 3; i++ {
		b.Append(Entry{Method: "m"})
	}
	got := b.Tail(0, 0)
	if len(got) != 3 {
		t.Fatalf("Tail len = %d, want 3", len(got))
	}
	if got[0].Seq != 1 || got[2].Seq != 3 {
		t.Fatalf("Tail not oldest-first: %v", got)
	}
}

func TestTailDropsOldestBeyondCapacity(t *testing.T) {
	b := New(3)
	for i := 0; i < 5; i++ {
		b.Append(Entry{Method: "m"})
	}
	if b.Len() != 3 {
		t.Fatalf("Len = %d, want 3", b.Len())
	}
	got := b.Tail(0, 0)
	if len(got) != 3 || got[0].Seq != 3 || got[2].Seq != 5 {
		t.Fatalf("oldest entries not dropped: %+v", got)
	}
}

func TestTailAfterCursorAndLimit(t *testing.T) {
	b := New(8)
	for i := 0; i < 4; i++ {
		b.Append(Entry{Method: "m"})
	}
	if got := b.Tail(2, 0); len(got) != 2 || got[0].Seq != 3 {
		t.Fatalf("Tail(after=2) = %+v", got)
	}
	if got := b.Tail(0, 2); len(got) != 2 || got[1].Seq != 2 {
		t.Fatalf("Tail(limit=2) = %+v", got)
	}
	if got := b.Tail(4, 0); len(got) != 0 {
		t.Fatalf("Tail(after=head) = %+v, want empty", got)
	}
}

func TestDefaultMaxForNonPositiveCapacity(t *testing.T) {
	b := New(0)
	if b.max != DefaultMax {
		t.Fatalf("max = %d, want %d", b.max, DefaultMax)
	}
}
