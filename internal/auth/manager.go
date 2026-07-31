package auth

import (
	"net/http"
	"time"

	"agent-compose-ui/internal/config"
)

const cookieName = "agent_compose_session"

type Manager struct {
	mode               config.AuthMode
	username, password string
	secret             []byte
	ttl                time.Duration
}

type statusResponse struct {
	Enabled   bool   `json:"enabled"`
	LoggedIn  bool   `json:"loggedIn"`
	Username  string `json:"username,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

func New(cfg config.Config) *Manager {
	return &Manager{
		mode:     cfg.AuthMode,
		username: cfg.AuthUsername,
		password: cfg.AuthPassword,
		secret:   []byte(cfg.AuthSecret),
		ttl:      cfg.SessionTTL,
	}
}

func (m *Manager) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.mode == config.AuthDisabled {
			next.ServeHTTP(w, r)
			return
		}
		if _, _, ok := m.validate(r); !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}
