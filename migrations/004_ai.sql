-- Per-project daily AI usage: questions asked and tokens spent (for quotas and cost visibility).
CREATE TABLE ai_usage (
  ref           text NOT NULL REFERENCES projects ON DELETE CASCADE,
  day           date NOT NULL,
  questions     int  NOT NULL DEFAULT 0,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (ref, day)
);
