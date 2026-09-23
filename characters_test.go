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
	for _, id := range []string{"", "goku", "dragon-chino\x00", strings.Repeat("x", 100)} {
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
	b.character = "robok"
	m := h.makeMatch("mc1", side{client: a}, side{client: b})
	m.start()

	md := waitForEvent(t, a, "matched")
	opp := md["opponentCharacter"].(string)
	if opp != "robok" {
		t.Errorf("a matched opponentCharacter = %q, want robok", opp)
	}
	m.ackReady(0)
	m.ackReady(1)

	waitForEvent(t, a, "shoot")
	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}
	b.moves <- moveMsg{move: MovePaper, arrive: time.Now()}

	ra := waitForEvent(t, a, "result")
	if ra["youCharacter"] != "dragon-chino" {
		t.Errorf("a youCharacter = %q, want dragon-chino", ra["youCharacter"])
	}
	if ra["opponentCharacter"] != "robok" {
		t.Errorf("a opponentCharacter = %q, want robok", ra["opponentCharacter"])
	}

	rb := waitForEvent(t, b, "result")
	if rb["youCharacter"] != "robok" {
		t.Errorf("b youCharacter = %q, want robok", rb["youCharacter"])
	}
	if rb["opponentCharacter"] != "dragon-chino" {
		t.Errorf("b opponentCharacter = %q, want dragon-chino", rb["opponentCharacter"])
	}
}

func TestMatchExposesBotCharacter(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("mc2", side{client: a}, side{bot: true, character: "rayito"})
	m.start()

	md := waitForEvent(t, a, "matched")
	if md["opponentCharacter"] != "rayito" {
		t.Errorf("matched opponentCharacter = %v, want rayito", md["opponentCharacter"])
	}
	if !validCharacter(m.opponentCharacter(0)) {
		t.Errorf("bot character not in roster")
	}
}
