package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (m *Manager) signedValue(username string, expires time.Time) string {
	payload := username + "\n" + strconv.FormatInt(expires.Unix(), 10)
	mac := hmac.New(sha256.New, m.secret)
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (m *Manager) validate(r *http.Request) (username string, expires time.Time, ok bool) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return "", time.Time{}, false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return "", time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", time.Time{}, false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", time.Time{}, false
	}
	mac := hmac.New(sha256.New, m.secret)
	_, _ = mac.Write(payload)
	if subtle.ConstantTimeCompare(signature, mac.Sum(nil)) != 1 {
		return "", time.Time{}, false
	}
	fields := strings.Split(string(payload), "\n")
	if len(fields) != 2 || fields[0] == "" {
		return "", time.Time{}, false
	}
	unix, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return "", time.Time{}, false
	}
	expires = time.Unix(unix, 0)
	if !expires.After(time.Now()) {
		return "", time.Time{}, false
	}
	return fields[0], expires, true
}
