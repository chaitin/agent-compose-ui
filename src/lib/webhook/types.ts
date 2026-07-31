export interface WebhookSource {
  id: string;
  name: string;
  enabled: boolean;
  provider: string;
  topic_prefix: string;
  has_token: boolean;
  token_header?: string;
  signature_type?: string;
  has_signature_secret: boolean;
  body_limit_bytes?: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookSourceRequest {
  id: string;
  name: string;
  enabled?: boolean;
  provider: string;
  topic_prefix: string;
  token?: string;
  token_hash?: string;
  token_header?: string;
  clear_token?: boolean;
  signature_type?: string;
  signature_secret?: string;
  clear_signature?: boolean;
  body_limit_bytes?: number;
}

export interface PublishResponse {
  accepted: boolean;
  topic: string;
  event_id: string;
  sequence: number;
  correlation_id: string;
}

export type TestPhase = 'idle' | 'sending' | 'success' | 'error';

export interface TestState {
  phase: Exclude<TestPhase, 'idle'>;
  status?: number;
  eventId?: string;
  sequence?: number;
  message?: string;
  at: number;
}
