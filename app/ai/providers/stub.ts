/**
 * Stub AI provider — always works, never calls external APIs.
 * Generates intent-aware clarifying questions based on missing fields.
 */

import type { AIRequest, AIResponse } from "../ai.server";

/**
 * Generate a helpful stub response based on the user's current intent state.
 * Asks one clarifying question for the first missing field.
 */
export function generateStubResponse(req: AIRequest): AIResponse {
    const { intent } = req;

    // Determine which fields are still unknown
    const missing: string[] = [];
    if (!intent?.petType || intent.petType === "unknown") missing.push("petType");
    if (!intent?.lifeStage || intent.lifeStage === "unknown") missing.push("lifeStage");
    if (!intent?.goal || intent.goal === "unknown") missing.push("goal");

    // Build a helpful reply based on what's missing
    let replyText: string;

    if (missing.length === 0) {
        // All key fields known — give a confident summary
        replyText = `Great! I can see you're looking for ${intent!.goal} for your ${intent!.lifeStage} ${intent!.petType}. Let me find the best options for you!`;
    } else {
        // Ask about the first missing field
        const field = missing[0];
        switch (field) {
            case "petType":
                replyText = "Is this for a dog or a cat? (Or another pet — just let me know!)";
                break;
            case "lifeStage":
                replyText = `Got it! Is your ${intent?.petType || "pet"} a puppy/kitten, an adult, or a senior?`;
                break;
            case "goal":
                replyText = `What are you looking for? For example: food, treats, toys, grooming supplies, or accessories?`;
                break;
            default:
                replyText = "I'm here to help! Tell me about your pet and what you're looking for.";
        }
    }

    return {
        replyText,
        recommendedHandles: [],
        reasons: {},
    };
}
