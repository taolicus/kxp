package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The server announces a background *name*; the WebPs themselves never leave the
// client. What that depends on is the two rosters agreeing, because a client
// handed a name it does not recognise has to fall back to picking for itself --
// and a server-side entry with no client-side counterpart would mean the two
// players quietly saw different stages while both screens looked correct.

var clientRoster = regexp.MustCompile(`const BGS = \[([^\]]*)\]`)

func TestBackgroundRosterMatchesTheClient(t *testing.T) {
	raw, err := os.ReadFile("web/app.js")
	if err != nil {
		t.Fatalf("read web/app.js: %v", err)
	}
	m := clientRoster.FindSubmatch(raw)
	if m == nil {
		t.Fatal("could not find the BGS roster in web/app.js")
	}
	var got []string
	for _, name := range strings.Split(string(m[1]), ",") {
		if n := strings.Trim(strings.TrimSpace(name), `"'`); n != "" {
			got = append(got, n)
		}
	}
	if len(got) == 0 {
		t.Fatal("parsed an empty roster out of web/app.js")
	}

	if len(got) != len(backgrounds) {
		t.Fatalf("client roster %v has %d entries, server roster %v has %d",
			got, len(got), backgrounds, len(backgrounds))
	}
	for i := range got {
		if got[i] != backgrounds[i] {
			t.Errorf("entry %d: client has %q, server has %q", i, got[i], backgrounds[i])
		}
	}
}

// Every match gets exactly one stage, and both sides are told the same one. A
// per-side choice would be a subtle bug to spot by eye -- two correct-looking
// screens disagreeing -- so it is pinned directly.
func TestBothSidesAreSentTheSameBackground(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("bg", side{client: a}, side{client: b})
	m.start()

	evA := waitForEvent(t, a, "matched")
	evB := waitForEvent(t, b, "matched")

	bgA, _ := evA["background"].(string)
	bgB, _ := evB["background"].(string)
	if bgA == "" {
		t.Fatal("matched carried no background")
	}
	if bgA != bgB {
		t.Fatalf("sides were sent different backgrounds: %q vs %q", bgA, bgB)
	}
	if !slicesContains(backgrounds, bgA) {
		t.Fatalf("background %q is not in the server roster %v", bgA, backgrounds)
	}
}

// A CPU match announces it too. The bot has no screen, but the human still needs
// a stage, and this is the path with the fewest moving parts -- so if the field
// ever goes missing it should surface here first.
func TestCPUMatchAnnouncesABackground(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("bgcpu", side{client: a}, side{bot: true})
	m.start()

	ev := waitForEvent(t, a, "matched")
	bg, _ := ev["background"].(string)
	if bg == "" {
		t.Fatal("CPU matched carried no background")
	}
	if !slicesContains(backgrounds, bg) {
		t.Fatalf("background %q is not in the server roster %v", bg, backgrounds)
	}
}

// The picker must be uniform enough to actually vary. This is not a distribution
// test -- it only fails if the roster collapsed to one entry or the index is
// pinned, which would make every match look the same forever.
func TestPickBackgroundVaries(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		bg := pickBackground()
		if !slicesContains(backgrounds, bg) {
			t.Fatalf("pickBackground returned %q, which is not in the roster", bg)
		}
		seen[bg] = true
	}
	if len(seen) < 2 {
		t.Fatalf("pickBackground only ever produced %v", seen)
	}
}

func slicesContains(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}
