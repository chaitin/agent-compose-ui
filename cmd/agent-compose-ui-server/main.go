package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"agent-compose-ui/internal/app"
	"agent-compose-ui/internal/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		logger.Error("gateway configuration error", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := app.Run(ctx, cfg, logger); err != nil {
		logger.Error("gateway server error", "error", err)
		os.Exit(1)
	}
}
