package main

import (
	"strings"
	"testing"
	"time"
)

func TestRosterDefaults(t *testing.T) {
	if !validCharacter(defaultCharacterID()) {
		t.Errorf("default character %q not in roster", defaultCharacterID())
	}
	for _, c := range characters {
		if !validCharacter(c.ID) {
			t.Errorf("roster id %q not valid", c.ID)
		}
		if c.Name == "" {
			t.Errorf("roster id %q has empty name", c.ID)
		}
	}
}

func TestValidCharacterRejectsUnknown(t *testing.T) {
	// "juan-cajeta\x00" is a real id with one byte of junk on the end: the check is
	// not just a lookup against the roster, so a name that is on the list cannot
	// smuggle a NUL through the id that reaches the wire and the ladder.
	for _, id := range []string{"", "goku", "juan-cajeta\x00", strings.Repeat("x", 100)} {
		if validCharacter(id) {
			t.Errorf("expected %q to be rejected", id)
		}
	}
}

func TestRandomCharacter(t *testing.T) {
	for i := 0; i < 100; i++ {
		if !validCharacter(randomCharacterID()) {
			t.Fatalf("randomCharacterID returned unknown id")
		}
	}
}

func TestRoundCarriesCharacters(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	b.character = "kamo"
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	// a chose nothing, so its side carries the default. Spelled as the default
	// rather than as the fighter that happens to be first: what this test claims is
	// that both characters reach the result frame, and which fighter is the default
	// is roster content (docs/features/characters.md), not part of that claim.
	wantA := defaultCharacterID()

	md := waitForEvent(t, a, "matched")
	opp := md["opponentCharacter"].(string)
	if opp != "kamo" {
		t.Errorf("a matched opponentCharacter = %q, want kamo", opp)
	}
	m.ackReady(0)
	m.ackReady(1)

	waitForEvent(t, a, "shoot")
	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}
	b.moves <- moveMsg{move: MovePaper, arrive: time.Now()}

	ra := waitForEvent(t, a, "result")
	if ra["youCharacter"] != wantA {
		t.Errorf("a youCharacter = %q, want %s", ra["youCharacter"], wantA)
	}
	if ra["opponentCharacter"] != "kamo" {
		t.Errorf("a opponentCharacter = %q, want kamo", ra["opponentCharacter"])
	}

	rb := waitForEvent(t, b, "result")
	if rb["youCharacter"] != "kamo" {
		t.Errorf("b youCharacter = %q, want kamo", rb["youCharacter"])
	}
	if rb["opponentCharacter"] != wantA {
		t.Errorf("b opponentCharacter = %q, want %s", rb["opponentCharacter"], wantA)
	}
}

func TestMatchExposesBotCharacter(t *testing.T) {
	h := NewHub()
	a := newClient()
	t.Cleanup(a.cancel) // a CPU match is a series: it would play rounds for the rest of the run
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{bot: true, character: "lucio"})
	m.start()

	md := waitForEvent(t, a, "matched")
	if md["opponentCharacter"] != "lucio" {
		t.Errorf("matched opponentCharacter = %v, want lucio", md["opponentCharacter"])
	}
	if !validCharacter(m.opponentCharacter(0)) {
		t.Errorf("bot character not in roster")
	}
}
