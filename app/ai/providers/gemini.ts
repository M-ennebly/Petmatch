/**
 * Gemini AI provider — calls Google Gemini 2.0 Flash.
 * Only activated when AI_MODE=gemini.
 * Falls back to stub on rate limit / quota / any error.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AIRequest, AIResponse } from "../ai.server";
import { generateStubResponse } from "./stub";
import db from "../../db.server";

const SYSTEM_PROMPT = `You are PetMatch, a customer-support and product-finding assistant for a Shopify pet store.
Rules:
- Ask at most one clarifying question at a time.
- Be concise (2–6 sentences).
- Do not invent product details or prices.
- If asked for medical advice, suggest consulting a vet.
- End with one clear next-step suggestion or question.`;

const TIMEOUT_MS = 10_000;

export async function generateGeminiResponse(req: AIRequest): Promise<AIResponse> {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error("[AI:gemini] GEMINI_API_KEY is not set, falling back to stub");
            return generateStubResponse(req);
        }

        // Load last 10 messages for context
        const recentMessages = await db.chatMessage.findMany({
            where: { sessionId: req.sessionId },
            orderBy: { createdAt: "desc" },
            take: 10,
        });
        recentMessages.reverse();

        // Build chat history
        const history = recentMessages.map((msg: { role: string; content: string | null }) => ({
            role: msg.role === "user" ? ("user" as const) : ("model" as const),
            parts: [{ text: msg.content || "" }],
        }));

        // Separate last user message
        const lastUserMessage = history.pop();
        if (!lastUserMessage || lastUserMessage.role !== "user") {
            return generateStubResponse(req);
        }

        // Initialize Gemini
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: "System instructions: " + SYSTEM_PROMPT }] },
                { role: "model", parts: [{ text: "Understood. I'm PetMatch, here to help customers find the perfect products for their pets. How can I help you today?" }] },
                ...history,
            ],
        });

        // Generate with timeout
        const result = await Promise.race([
            chat.sendMessage(lastUserMessage.parts[0].text),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Gemini request timed out after 10s")), TIMEOUT_MS)
            ),
        ]);

        const replyText = result.response.text()?.trim();

        if (!replyText) {
            console.warn("[AI:gemini] Empty response, falling back to stub");
            return generateStubResponse(req);
        }

        return {
            replyText,
            recommendedHandles: [],
            reasons: {},
        };
    } catch (error: any) {
        const msg = error?.message || String(error);
        const isRateLimit = msg.includes("429") || msg.includes("quota") || msg.includes("rate") || msg.includes("Resource has been exhausted");

        console.error(`[AI:gemini] ${isRateLimit ? "Rate limited" : "Error"}: ${msg}`);
        console.log("[AI:gemini] Falling back to stub response");

        return generateStubResponse(req);
    }
}
