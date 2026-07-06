package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (a *Manager) cookie(value string, expiresAt time.Time) *http.Cookie {
	maxAge := int(time.Until(expiresAt).Seconds())
	if value == "" {
		maxAge = -1
	}
	return &http.Cookie{Name: authCookieName, Value: value, Path: "/", Expires: expiresAt, MaxAge: maxAge, HttpOnly: true, SameSite: http.SameSiteLaxMode}
}

func (a *Manager) oauthStateCookie(state, next string, expiresAt time.Time) *http.Cookie {
	maxAge := int(time.Until(expiresAt).Seconds())
	if state == "" {
		maxAge = -1
	}
	return &http.Cookie{Name: oauthStateCookieName, Value: encodeOAuthStateCookie(state, next), Path: "/", Expires: expiresAt, MaxAge: maxAge, HttpOnly: true, SameSite: http.SameSiteLaxMode}
}

func (a *Manager) signedValue(username string, expiresAt time.Time) string {
	expiry := strconv.FormatInt(expiresAt.Unix(), 10)
	payload := username + "|" + expiry
	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write([]byte(payload))
	value := payload + "|" + hex.EncodeToString(mac.Sum(nil))
	return base64.RawURLEncoding.EncodeToString([]byte(value))
}

func (a *Manager) validateRequest(r *http.Request) (string, time.Time, bool) {
	if !a.enabled {
		return "", time.Time{}, true
	}
	if username, password, ok := r.BasicAuth(); ok && a.password != "" {
		if constantTimeEqual(username, a.username) && constantTimeEqual(password, a.password) {
			return a.username, time.Now().UTC().Add(a.ttl), true
		}
		return "", time.Time{}, false
	}
	cookie, err := r.Cookie(authCookieName)
	if err != nil || cookie.Value == "" {
		return "", time.Time{}, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil {
		return "", time.Time{}, false
	}
	parts := strings.Split(string(decoded), "|")
	if len(parts) != 3 {
		return "", time.Time{}, false
	}
	username, expiry, signature := parts[0], parts[1], parts[2]
	expiresUnix, err := strconv.ParseInt(expiry, 10, 64)
	if err != nil {
		return "", time.Time{}, false
	}
	expiresAt := time.Unix(expiresUnix, 0).UTC()
	if !time.Now().UTC().Before(expiresAt) {
		return "", time.Time{}, false
	}
	if username != a.username && (!a.oauthEnabled || username == "") {
		return "", time.Time{}, false
	}
	expected := a.signedValue(username, expiresAt)
	if subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(expected)) != 1 {
		return "", time.Time{}, false
	}
	if _, err := hex.DecodeString(signature); err != nil {
		return "", time.Time{}, false
	}
	return username, expiresAt, true
}

func generateOAuthState(length int) (string, error) {
	if length <= 0 {
		length = 16
	}
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func encodeOAuthStateCookie(state, next string) string {
	payload := state + "|" + sanitizeOAuthNext(next)
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func decodeOAuthStateCookie(value string) (string, string, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", "", false
	}
	parts := strings.SplitN(string(decoded), "|", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], sanitizeOAuthNext(parts[1]), true
}

func constantTimeEqual(left, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
