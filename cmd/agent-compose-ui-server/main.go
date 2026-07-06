package main

import (
	"log"

	"agent-compose-ui/internal/app"
)

func main() {
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
