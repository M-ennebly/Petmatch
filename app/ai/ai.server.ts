/**
 * Single AI entrypoint for the entire app.
 * Routes to stub or gemini provider based on AI_MODE env var.
 *
 * Usage:
 *   import { generateAssistantResponse } from "~/ai/ai.server";
 *   const response = await generateAssistantResponse({ shopDomain, sessionId, intent });
 *
 * Env:
 *   AI_MODE=stub   → always uses stub (default, stable)
 *   AI_MODE=gemini → attempts Gemini, falls back to stub on error
 */

import { generateStubResponse } from "./providers/stub";
import { generateGeminiResponse } from "./providers/gemini";

// ── Stable interface types ─────────────────────────────────────────────────────

export interface AIRequest {
    shopDomain: string;
    sessionId: string;
    intent?: {
        petType?: string;
        lifeStage?: string;
        goal?: string;
        constraints?: string[];
        budget?: string;
        confidence?: number;
    };
}

export interface AIResponse {
    replyText: string;
    recommendedHandles: string[];
    reasons: Record<string, string>;
}

// ── Router ─────────────────────────────────────────────────────────────────────

export async function generateAssistantResponse(req: AIRequest): Promise<AIResponse> {
    const mode = (process.env.AI_MODE || "stub").toLowerCase();

    console.log(`[AI] Mode: ${mode} | Shop: ${req.shopDomain} | Session: ${req.sessionId}`);

    switch (mode) {
        case "gemini":
            return generateGeminiResponse(req);

        case "stub":
        default:
            return generateStubResponse(req);
    }
}
