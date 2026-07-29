package projectdeploy

import (
	"net/url"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

func marshalProjectYAML(spec map[string]any) (string, error) {
	content, err := yaml.Marshal(projectYAMLValue(spec, "", false))
	if err != nil {
		return "", err
	}
	return string(content), nil
}

func projectYAMLValue(value any, key string, redactStrings bool) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		secretValue := boolValue(typed["secret"])
		namedSecret := sensitiveConfigKey(stringValue(typed["name"]))
		for childKey, childValue := range typed {
			redactChild := redactStrings || sensitiveConfigContainer(childKey) ||
				((secretValue || namedSecret) && childKey == "value")
			result[yamlConfigKey(childKey)] = projectYAMLValue(childValue, childKey, redactChild)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = projectYAMLValue(item, key, redactStrings)
		}
		return result
	case string:
		if redactStrings || sensitiveConfigKey(key) {
			if typed == "" {
				return ""
			}
			return redactedSecret
		}
		if key == "url" {
			return sanitizedConfigURL(typed)
		}
		return friendlyConfigEnum(key, typed)
	default:
		return typed
	}
}

func sensitiveConfigContainer(key string) bool {
	normalized := strings.ToLower(yamlConfigKey(key))
	return normalized == "secrets"
}

func sensitiveConfigKey(key string) bool {
	normalized := compactConfigKey(key)
	switch normalized {
	case "token", "apikey", "password", "credential", "authorization", "secretvalue":
		return true
	default:
		return strings.HasSuffix(normalized, "token") || strings.HasSuffix(normalized, "password") ||
			strings.HasSuffix(normalized, "credential") || strings.HasSuffix(normalized, "apikey")
	}
}

func compactConfigKey(value string) string {
	return strings.Map(func(current rune) rune {
		if unicode.IsLetter(current) || unicode.IsDigit(current) {
			return unicode.ToLower(current)
		}
		return -1
	}, value)
}

func sanitizedConfigURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" {
		return value
	}
	if parsed.User != nil {
		parsed.User = url.User(redactedSecret)
	}
	query := parsed.Query()
	for key := range query {
		if sensitiveConfigKey(key) {
			query.Set(key, redactedSecret)
		}
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func friendlyConfigEnum(key, value string) string {
	prefixes := map[string]string{
		"kind":               "TRIGGER_KIND_",
		"sandboxPolicy":      "SCHEDULER_SANDBOX_POLICY_",
		"concurrencyPolicy":  "SCHEDULER_CONCURRENCY_POLICY_",
		"sandbox_policy":     "SCHEDULER_SANDBOX_POLICY_",
		"concurrency_policy": "SCHEDULER_CONCURRENCY_POLICY_",
	}
	prefix := prefixes[key]
	if prefix != "" && strings.HasPrefix(value, prefix) {
		return strings.ToLower(strings.TrimPrefix(value, prefix))
	}
	return value
}

func yamlConfigKey(value string) string {
	var result strings.Builder
	for index, current := range value {
		if unicode.IsUpper(current) {
			if index > 0 {
				result.WriteByte('_')
			}
			result.WriteRune(unicode.ToLower(current))
			continue
		}
		result.WriteRune(current)
	}
	return result.String()
}
