package auth

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"agent-compose-ui/internal/config"
)

const maxLoginBody = 4096

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (m *Manager) Status(w http.ResponseWriter, r *http.Request) {
	status := statusResponse{Enabled: m.mode != config.AuthDisabled}
	if status.Enabled {
		if username, expires, ok := m.validate(r); ok {
			status.LoggedIn = true
			status.Username = username
			status.ExpiresAt = expires.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, status)
}

func (m *Manager) Login(w http.ResponseWriter, r *http.Request) {
	if m.mode != config.AuthPassword {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxLoginBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var credentials loginRequest
	if err := decoder.Decode(&credentials); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	usernameOK := subtle.ConstantTimeCompare([]byte(credentials.Username), []byte(m.username))
	passwordOK := subtle.ConstantTimeCompare([]byte(credentials.Password), []byte(m.password))
	if usernameOK&passwordOK != 1 {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	expires := time.Now().Add(m.ttl)
	http.SetCookie(w, m.cookie(r, m.signedValue(credentials.Username, expires), expires, 0))
	writeJSON(w, http.StatusOK, statusResponse{
		Enabled: true, LoggedIn: true, Username: credentials.Username,
		ExpiresAt: expires.UTC().Format(time.RFC3339),
	})
}

func (m *Manager) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, m.cookie(r, "", time.Unix(1, 0), -1))
	writeJSON(w, http.StatusOK, statusResponse{Enabled: m.mode != config.AuthDisabled})
}

func (m *Manager) cookie(r *http.Request, value string, expires time.Time, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name: cookieName, Value: value, Path: "/", Expires: expires, MaxAge: maxAge,
		HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
