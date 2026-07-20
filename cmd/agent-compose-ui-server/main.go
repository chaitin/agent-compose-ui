package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"agent-compose-ui/internal/app"
	"agent-compose-ui/internal/config"
)

func main() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		log.Fatalf("gateway configuration error: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := app.Run(ctx, cfg); err != nil {
		log.Fatalf("gateway server error: %v", err)
	}
}
