package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Move string
type Result string

const (
	Rock     Move = "rock"
	Paper    Move = "paper"
	Scissors Move = "scissors"

	Win  Result = "win"
	Loss Result = "loss"
	Draw Result = "draw"
)

// Ordered slice of choices for the menu
var menuOptions = []Move{Rock, Paper, Scissors}

var winsAgainst = map[Move]Move{
	Rock:     Scissors,
	Paper:    Rock,
	Scissors: Paper,
}

func EvaluateRound(p1, p2 Move) Result {
	if p1 == p2 {
		return Draw
	}
	if winsAgainst[p1] == p2 {
		return Win
	}
	return Loss
}

// promptMove displays a numbered list and returns the selected Move.
func promptMove(reader *bufio.Reader, playerLabel string) Move {
	for {
		fmt.Printf("\n%s, choose your move:\n", playerLabel)
		for i, option := range menuOptions {
			fmt.Printf(" [%d] %s\n", i+1, strings.Title(string(option)))
		}
		fmt.Print("Enter choice (1-3): ")

		input, err := reader.ReadString('\n')
		if err != nil {
			fmt.Println("Error reading input, try again.")
			continue
		}

		// Convert input string to integer
		choice, err := strconv.Atoi(strings.TrimSpace(input))
		if err == nil && choice >= 1 && choice <= len(menuOptions) {
			return menuOptions[choice-1]
		}

		fmt.Println("Invalid choice! Please enter a number between 1 and 3.")
	}
}

func main() {
	reader := bufio.NewReader(os.Stdin)

	fmt.Println("=== Terminal Rock Paper Scissors ===")

	p1Move := promptMove(reader, "Player 1")
	p2Move := promptMove(reader, "Player 2")

	result := EvaluateRound(p1Move, p2Move)

	fmt.Println("\n--- Outcome ---")
	fmt.Printf("Player 1 chose %s, Player 2 chose %s.\n", p1Move, p2Move)

	switch result {
	case Draw:
		fmt.Println("It's a draw!")
	case Win:
		fmt.Println("Player 1 wins!")
	case Loss:
		fmt.Println("Player 2 wins!")
	}
}
