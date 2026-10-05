package main

import "math/rand/v2"

type Character struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Emoji string `json:"emoji"`
}

var characters = []Character{
	{ID: "juan-cajeta", Name: "Juan Cajeta", Emoji: "🕶️"},
	{ID: "kamo", Name: "Kamo", Emoji: "🔴"},
	{ID: "ema", Name: "Ema", Emoji: "⚡"},
	{ID: "taolikus", Name: "Taolikus", Emoji: "🐉"},
	{ID: "lucio", Name: "Lucio", Emoji: "🦂"},
	{ID: "hielitalo", Name: "Hielítalo", Emoji: "🧊"},
	{ID: "ko-shi-nin", Name: "Ko Shi Nin", Emoji: "🗡️"},
}

func characterByID(id string) (Character, bool) {
	for _, c := range characters {
		if c.ID == id {
			return c, true
		}
	}
	return Character{}, false
}

func defaultCharacterID() string {
	return characters[0].ID
}

func validCharacter(id string) bool {
	_, ok := characterByID(id)
	return ok
}

func randomCharacterID() string {
	return characters[rand.IntN(len(characters))].ID
}
