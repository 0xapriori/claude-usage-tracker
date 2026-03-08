// OTLP JSON metric payload types

export interface OtlpAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

export interface OtlpDataPoint {
  asInt?: string;
  asDouble?: number;
  attributes: OtlpAttribute[];
  timeUnixNano: string;
  startTimeUnixNano?: string;
}

export interface OtlpMetric {
  name: string;
  sum?: {
    dataPoints: OtlpDataPoint[];
    isMonotonic?: boolean;
    aggregationTemporality?: number;
  };
  gauge?: {
    dataPoints: OtlpDataPoint[];
  };
}

export interface OtlpScopeMetrics {
  scope?: { name?: string; version?: string };
  metrics: OtlpMetric[];
}

export interface OtlpResourceMetrics {
  resource?: {
    attributes?: OtlpAttribute[];
  };
  scopeMetrics: OtlpScopeMetrics[];
}

export interface OtlpMetricsPayload {
  resourceMetrics: OtlpResourceMetrics[];
}

// Internal types

export interface TokenUsageRow {
  id: number;
  timestamp: string;
  session_id: string | null;
  model: string | null;
  token_type: string;
  count: number;
  created_at: string;
}

export interface CostUsageRow {
  id: number;
  timestamp: string;
  session_id: string | null;
  model: string | null;
  cost_usd: number;
  created_at: string;
}

export interface UsageSummary {
  startDate: string;
  endDate: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  };
  cost: number;
  byModel: Record<string, { tokens: number; cost: number }>;
  byDay: Record<string, { tokens: number; cost: number }>;
  sessionCount: number;
}
