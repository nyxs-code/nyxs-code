import { streamText, type LanguageModel, type ModelMessage, type ToolCallRepairFunction, type ToolSet } from "ai";

type StreamOptions = Parameters<typeof streamText<ToolSet>>[0];

export interface CallModelRequest {
  model: LanguageModel;
  messages: ModelMessage[];
  system?: string;
  tools?: ToolSet;
  activeTools?: string[];
  stopWhen?: StreamOptions["stopWhen"];
  prepareStep?: (step: { messages: ModelMessage[]; stepNumber: number }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  onStepFinish?: (step: { response: { messages: ModelMessage[] }; usage?: { inputTokens?: number } }) => void;
  repairToolCall?: ToolCallRepairFunction<ToolSet>;
  transform?: StreamOptions["experimental_transform"];
  maxRetries?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
  abortSignal?: AbortSignal;
}

export type CallModelResult = ReturnType<typeof streamText<ToolSet>>;

export type ModelCallOptions = Pick<CallModelRequest, "maxOutputTokens" | "providerOptions">;

export function callModel(request: CallModelRequest): CallModelResult {
  const { repairToolCall, transform, ...rest } = request;
  return streamText({
    ...rest,
    allowSystemInMessages: true,
    experimental_repairToolCall: repairToolCall,
    experimental_transform: transform,
  } as unknown as StreamOptions);
}
