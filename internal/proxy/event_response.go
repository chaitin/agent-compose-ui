package proxy

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

const maxFilteredResponseBytes = 32 << 20

const projectServicePath = "/agentcompose.v2.ProjectService/"

type schedulerResponseShape int

const (
	schedulerResponseNone schedulerResponseShape = iota
	schedulerResponseRuns
	schedulerResponseEvents
	schedulerResponseSandboxRuns
)

func isEventDocumentPath(path string) bool {
	parts := strings.Split(strings.Trim(strings.TrimSpace(path), "/"), "/")
	return len(parts) >= 2 && len(parts) <= 3 && parts[0] == "api" && parts[1] == "events"
}

func isSensitiveResponsePath(path string) bool {
	return isEventDocumentPath(path) || schedulerShape(path) != schedulerResponseNone
}

func schedulerShape(path string) schedulerResponseShape {
	method := strings.TrimPrefix(strings.TrimSpace(path), projectServicePath)
	if method == path {
		return schedulerResponseNone
	}
	switch method {
	case "RunScheduler", "StartSchedulerRun", "GetSchedulerRun", "ListSchedulerRuns", "StopSchedulerRun", "StreamSchedulerRuns":
		return schedulerResponseRuns
	case "ListSchedulerEvents", "ListProjectSchedulerEvents", "StreamProjectSchedulerEvents":
		return schedulerResponseEvents
	case "BatchGetLatestSchedulerRuns":
		return schedulerResponseSandboxRuns
	default:
		return schedulerResponseNone
	}
}

func redactSensitiveResponse(response *http.Response) error {
	if response == nil || response.Request == nil || response.StatusCode != http.StatusOK ||
		!isSensitiveResponsePath(response.Request.URL.Path) {
		return nil
	}
	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" && encoding != "identity" {
		return fmt.Errorf("filter event response with unsupported content encoding %q", encoding)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxFilteredResponseBytes+1))
	if closeErr := response.Body.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("read sensitive response: %w", err)
	}
	if len(body) > maxFilteredResponseBytes {
		return fmt.Errorf("sensitive response exceeds %d bytes", maxFilteredResponseBytes)
	}
	filtered, err := filterSensitiveBody(response, body)
	if err != nil {
		return fmt.Errorf("filter sensitive response: %w", err)
	}
	response.Body = io.NopCloser(bytes.NewReader(filtered))
	response.ContentLength = int64(len(filtered))
	response.Header.Set("Content-Length", strconv.Itoa(len(filtered)))
	return nil
}

func filterSensitiveBody(response *http.Response, body []byte) ([]byte, error) {
	if isEventDocumentPath(response.Request.URL.Path) {
		return removeEventPayloads(body)
	}
	shape := schedulerShape(response.Request.URL.Path)
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if strings.Contains(contentType, "grpc-web-text") {
		decoded := make([]byte, base64.StdEncoding.DecodedLen(len(body)))
		n, err := base64.StdEncoding.Decode(decoded, body)
		if err != nil {
			return nil, err
		}
		filtered, err := removeSchedulerFramedPayloads(decoded[:n], shape, strings.Contains(contentType, "json"))
		if err != nil {
			return nil, err
		}
		encoded := make([]byte, base64.StdEncoding.EncodedLen(len(filtered)))
		base64.StdEncoding.Encode(encoded, filtered)
		return encoded, nil
	}
	if strings.Contains(contentType, "grpc-web") {
		return removeSchedulerFramedPayloads(body, shape, strings.Contains(contentType, "json"))
	}
	if strings.Contains(contentType, "application/connect+") {
		return removeSchedulerFramedPayloads(body, shape, strings.Contains(contentType, "json"))
	}
	if strings.Contains(contentType, "json") {
		return removeSchedulerJSONPayloads(body, shape)
	}
	return removeSchedulerProtoMessage(body, shape)
}

func removeSchedulerFramedPayloads(body []byte, shape schedulerResponseShape, jsonFormat bool) ([]byte, error) {
	if jsonFormat {
		return transformGRPCWebFrames(body, func(message []byte) ([]byte, error) {
			return removeSchedulerJSONPayloads(message, shape)
		})
	}
	return removeSchedulerProtoPayloads(body, shape)
}

func removeSchedulerJSONPayloads(body []byte, shape schedulerResponseShape) ([]byte, error) {
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, err
	}
	deletePayload := func(value any) {
		if item, ok := value.(map[string]any); ok {
			delete(item, "payloadJson")
			delete(item, "payload_json")
		}
	}
	switch shape {
	case schedulerResponseRuns:
		deletePayload(document["run"])
		for _, item := range jsonArray(document["runs"]) {
			deletePayload(item)
		}
	case schedulerResponseEvents:
		for _, item := range jsonArray(document["events"]) {
			deletePayload(item)
		}
	case schedulerResponseSandboxRuns:
		for _, item := range jsonArray(document["results"]) {
			if result, ok := item.(map[string]any); ok {
				deletePayload(result["run"])
			}
		}
	}
	return json.Marshal(document)
}

func jsonArray(value any) []any {
	items, _ := value.([]any)
	return items
}

func removeSchedulerProtoPayloads(body []byte, shape schedulerResponseShape) ([]byte, error) {
	return transformGRPCWebFrames(body, func(message []byte) ([]byte, error) {
		return removeSchedulerProtoMessage(message, shape)
	})
}

func removeSchedulerProtoMessage(message []byte, shape schedulerResponseShape) ([]byte, error) {
	return transformProtoMessage(message, func(fieldNumber int, wireType byte, value []byte) ([]byte, bool, error) {
		if fieldNumber != 1 || wireType != 2 {
			return nil, false, nil
		}
		var transform func([]byte) ([]byte, error)
		switch shape {
		case schedulerResponseRuns:
			transform = func(nested []byte) ([]byte, error) { return removeProtoField(nested, 14) }
		case schedulerResponseEvents:
			transform = func(nested []byte) ([]byte, error) { return removeProtoField(nested, 5) }
		case schedulerResponseSandboxRuns:
			transform = func(nested []byte) ([]byte, error) {
				return transformNestedProtoField(nested, 2, func(run []byte) ([]byte, error) { return removeProtoField(run, 14) })
			}
		default:
			return nil, false, nil
		}
		filtered, err := transform(value)
		return filtered, true, err
	})
}

func transformGRPCWebFrames(body []byte, transform func([]byte) ([]byte, error)) ([]byte, error) {
	var out bytes.Buffer
	for len(body) > 0 {
		if len(body) < 5 {
			return nil, io.ErrUnexpectedEOF
		}
		flags := body[0]
		length := int(binary.BigEndian.Uint32(body[1:5]))
		if length < 0 || len(body) < 5+length {
			return nil, io.ErrUnexpectedEOF
		}
		frame := body[5 : 5+length]
		if flags&0x80 == 0 {
			filtered, err := transform(frame)
			if err != nil {
				return nil, err
			}
			frame = filtered
		}
		_ = out.WriteByte(flags)
		var size [4]byte
		binary.BigEndian.PutUint32(size[:], uint32(len(frame)))
		_, _ = out.Write(size[:])
		_, _ = out.Write(frame)
		body = body[5+length:]
	}
	return out.Bytes(), nil
}

type protoFieldTransform func(fieldNumber int, wireType byte, value []byte) ([]byte, bool, error)

func transformProtoMessage(message []byte, transform protoFieldTransform) ([]byte, error) {
	var out bytes.Buffer
	for len(message) > 0 {
		fieldStart := message
		key, keyLength := consumeProtoVarint(message)
		if keyLength <= 0 {
			return nil, fmt.Errorf("invalid protobuf field key")
		}
		message = message[keyLength:]
		wireType := byte(key & 7)
		value, valueLength, err := consumeProtoValue(message, wireType)
		if err != nil {
			return nil, err
		}
		encodedLength := keyLength + valueLength
		fieldNumber := int(key >> 3)
		if replacement, replaced, err := transform(fieldNumber, wireType, value); err != nil {
			return nil, err
		} else if replaced {
			writeProtoBytesField(&out, key, replacement)
		} else {
			_, _ = out.Write(fieldStart[:encodedLength])
		}
		message = message[valueLength:]
	}
	return out.Bytes(), nil
}

func removeProtoField(message []byte, target int) ([]byte, error) {
	return transformProtoMessage(message, func(fieldNumber int, _ byte, _ []byte) ([]byte, bool, error) {
		if fieldNumber == target {
			return nil, true, nil
		}
		return nil, false, nil
	})
}

func transformNestedProtoField(message []byte, target int, transform func([]byte) ([]byte, error)) ([]byte, error) {
	return transformProtoMessage(message, func(fieldNumber int, wireType byte, value []byte) ([]byte, bool, error) {
		if fieldNumber != target || wireType != 2 {
			return nil, false, nil
		}
		filtered, err := transform(value)
		return filtered, true, err
	})
}

func consumeProtoVarint(value []byte) (uint64, int) {
	var result uint64
	for index, current := range value {
		if index == 10 || index == 9 && current > 1 {
			return 0, -1
		}
		result |= uint64(current&0x7f) << (7 * index)
		if current < 0x80 {
			return result, index + 1
		}
	}
	return 0, 0
}

func consumeProtoValue(message []byte, wireType byte) ([]byte, int, error) {
	switch wireType {
	case 0:
		_, length := consumeProtoVarint(message)
		if length <= 0 {
			return nil, 0, io.ErrUnexpectedEOF
		}
		return message[:length], length, nil
	case 1:
		if len(message) < 8 {
			return nil, 0, io.ErrUnexpectedEOF
		}
		return message[:8], 8, nil
	case 2:
		length, prefixLength := consumeProtoVarint(message)
		if prefixLength <= 0 || length > uint64(len(message)-prefixLength) {
			return nil, 0, io.ErrUnexpectedEOF
		}
		end := prefixLength + int(length)
		return message[prefixLength:end], end, nil
	case 5:
		if len(message) < 4 {
			return nil, 0, io.ErrUnexpectedEOF
		}
		return message[:4], 4, nil
	default:
		return nil, 0, fmt.Errorf("unsupported protobuf wire type %d", wireType)
	}
}

func writeProtoBytesField(out *bytes.Buffer, key uint64, value []byte) {
	writeProtoVarint(out, key)
	writeProtoVarint(out, uint64(len(value)))
	_, _ = out.Write(value)
}

func writeProtoVarint(out *bytes.Buffer, value uint64) {
	for value >= 0x80 {
		_ = out.WriteByte(byte(value) | 0x80)
		value >>= 7
	}
	_ = out.WriteByte(byte(value))
}

func removeEventPayloads(body []byte) ([]byte, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, err
	}
	if raw, ok := document["event"]; ok {
		filtered, err := removePayload(raw)
		if err != nil {
			return nil, err
		}
		document["event"] = filtered
	}
	if raw, ok := document["items"]; ok {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, err
		}
		for index, item := range items {
			filtered, err := removePayload(item)
			if err != nil {
				return nil, err
			}
			items[index] = filtered
		}
		filtered, err := json.Marshal(items)
		if err != nil {
			return nil, err
		}
		document["items"] = filtered
	}
	return json.Marshal(document)
}

func removePayload(raw json.RawMessage) (json.RawMessage, error) {
	var event map[string]json.RawMessage
	if err := json.Unmarshal(raw, &event); err != nil {
		return nil, err
	}
	delete(event, "payload")
	return json.Marshal(event)
}
