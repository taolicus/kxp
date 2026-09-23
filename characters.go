package main

import "math/rand/v2"

type Character struct {
	ID   string
	Name string
}

var characters = []Character{
	{ID: "scorpion", Name: "Alakran"},
	{ID: "liukang", Name: "Fueguito"},
	{ID: "johnnycage", Name: "Galancito"},
	{ID: "kunglao", Name: "Sombrerito"},
	{ID: "kitana", Name: "Abaniquita"},
	{ID: "mileena", Name: "Colmillita"},
	{ID: "reptile", Name: "Lagartijo"},
	{ID: "subzero", Name: "Hielito"},
	{ID: "jax", Name: "Bracitos"},
	{ID: "baraka", Name: "Navajita"},
	{ID: "shangtsung", Name: "Abuelito"},
	{ID: "smoke", Name: "Humito"},
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
