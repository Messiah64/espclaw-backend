export type ToolRiskLevel = "read_only" | "low_risk_write" | "sensitive_write" | "destructive";

export type AssistantToolDefinition = {
  name: string;
  description: string;
  risk: ToolRiskLevel;
  parameters: Record<string, unknown>;
};

export type ToolExecutionContext = {
  userId: string;
  deviceId?: string;
  conversationId?: string;
  approvalId?: string;
};

export type ToolExecutionResult = {
  ok: boolean;
  text: string;
  data?: unknown;
  pendingApprovalId?: string;
};

