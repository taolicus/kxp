package main

import (
	"bufio"
	"fmt"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"time"
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

type InputResult struct {
	Move          Move
	InputTime     time.Time
	TimeDifference time.Duration // How far off from target reveal time
}

// Visual countdown running concurrently
func runCountdown(targetTimeChan chan time.Time) {
	countdown := []string{"ROCK...", "PAPER...", "SCISSORS..."}
	fmt.Println("\n=== GET READY ===")
	fmt.Println("Enter your move (1: Rock, 2: Paper, 3: Scissors) right on SHOOT!\n")

	for _, word := range countdown {
		fmt.Println(word)
		time.Sleep(1 * time.Second)
	}

	// Lock in target time and announce SHOOT!
	targetTime := time.Now()
	targetTimeChan <- targetTime
	fmt.Println("\n*** SHOOT! ***")
}

// Non-blocking input collection
func getPlayerInput(reader *bufio.Reader, inputChan chan InputResult) {
	for {
		input, err := reader.ReadString('\n')
		inputTime := time.Now()
		if err != nil {
			continue
		}

		choice, err := strconv.Atoi(strings.TrimSpace(input))
		if err == nil && choice >= 1 && choice <= len(menuOptions) {
			inputChan <- InputResult{
				Move:      menuOptions[choice-1],
				InputTime: inputTime,
			}
			return
		}
	}
}

// CPU simulated input timed closely around SHOOT!
func getCPUInput(targetTime time.Time, cpuChan chan InputResult) {
	// CPU reacts between 50ms and 350ms AFTER shoot
	reactionDelay := time.Duration(50+rand.Intn(300)) * time.Millisecond
	time.Sleep(reactionDelay)

	cpuChan <- InputResult{
		Move:          menuOptions[rand.Intn(len(menuOptions))],
		InputTime:     targetTime.Add(reactionDelay),
		TimeDifference: reactionDelay,
	}
}

func main() {
	reader := bufio.NewReader(os.Stdin)

	targetTimeChan := make(chan time.Time)
	playerInputChan := make(chan InputResult)
	cpuChan := make(chan InputResult)

	// 1. Start player input listener goroutine immediately
	go getPlayerInput(reader, playerInputChan)

	// 2. Start visual countdown concurrently
	go runCountdown(targetTimeChan)

	// Wait for target time ("SHOOT!") to be generated
	targetTime := <-targetTimeChan

	// 3. Start CPU reaction thread synced to target time
	go getCPUInput(targetTime, cpuChan)

	// 4. Collect results with a maximum time limit (e.g., 2 seconds past target)
	var playerRes, cpuRes InputResult
	playerSubmitted := false

	timeout := time.After(2 * time.Second)

	for !playerSubmitted {
		select {
		case pInput := <-playerInputChan:
			playerRes = pInput
			playerRes.TimeDifference = playerRes.InputTime.Sub(targetTime)
			playerSubmitted = true
		case <-timeout:
			fmt.Println("\n\nToo slow! You failed to enter a move in time.")
			return
		}
	}

	cpuRes = <-cpuChan

	// 5. Evaluate results and timing accuracy
	fmt.Println("\n--- Outcome ---")
	fmt.Printf("You chose %s (Timing: %v relative to SHOOT!)\n", strings.ToUpper(string(playerRes.Move)), playerRes.TimeDifference)
	fmt.Printf("CPU chose %s (Timing: +%v relative to SHOOT!)\n", strings.ToUpper(string(cpuRes.Move)), cpuRes.TimeDifference)

	// Check for early penalty (jumped the gun by > 200ms)
	if playerRes.TimeDifference < -200*time.Millisecond {
		fmt.Println("\nDisqualified! You entered your move too early before SHOOT!")
		return
	}

	result := EvaluateRound(playerRes.Move, cpuRes.Move)
	switch result {
	case Draw:
		fmt.Println("It's a draw!")
	case Win:
		fmt.Println("You win!")
	case Loss:
		fmt.Println("Computer wins!")
	}
}
