import db from "../db.server";

// ── Dynamic CORS ─────────────────────────────────────────────────────────────

/**
 * Build CORS headers that allow only the requesting shop's domain.
 * Accepts *.myshopify.com origins and the app's own URL (for dev tunnels).
 */
export function buildCorsHeaders(request: Request, shopDomain?: string): Record<string, string> {
    const origin = request.headers.get("Origin") || "";
    const appUrl = process.env.SHOPIFY_APP_URL || "";

    const allowed = isOriginAllowed(origin, shopDomain, appUrl);

    return {
        "Access-Control-Allow-Origin": allowed ? origin : "",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, ngrok-skip-browser-warning",
        "Access-Control-Max-Age": "86400",
        ...(allowed ? { "Vary": "Origin" } : {}),
    };
}

function isOriginAllowed(origin: string, shopDomain?: string, appUrl?: string): boolean {
    if (!origin) return true; // Same-origin requests have no Origin header

    // Allow the app's own URL (dev tunnel, preview, etc.)
    if (appUrl && origin === new URL(appUrl).origin) return true;

    // Allow the shop's .myshopify.com storefront
    if (shopDomain) {
        const shopBase = shopDomain.replace(/\.myshopify\.com$/, "");
        if (origin === `https://${shopBase}.myshopify.com`) return true;
        // Also allow custom domains — the shop domain itself
        if (origin === `https://${shopDomain}`) return true;
    }

    // Allow any *.myshopify.com origin (widget loads on storefront)
    if (/^https:\/\/[a-z0-9-]+\.myshopify\.com$/.test(origin)) return true;

    return false;
}

/**
 * Create a preflight (OPTIONS) response with proper CORS headers.
 */
export function preflightResponse(request: Request, shopDomain?: string): Response {
    return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(request, shopDomain),
    });
}

// ── Rate Limiter ─────────────────────────────────────────────────────────────

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanupExpired() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL) return;
    lastCleanup = now;

    for (const [key, entry] of rateLimitStore) {
        if (now > entry.resetAt) {
            rateLimitStore.delete(key);
        }
    }
}

/**
 * Check rate limit for a given key.
 * @param key   Unique identifier, e.g. "chat:shop.myshopify.com:browserId123"
 * @param limit Max requests allowed in the window
 * @param windowMs Window duration in milliseconds (default 60s)
 */
export function checkRateLimit(
    key: string,
    limit: number,
    windowMs: number = 60_000
): { allowed: boolean; remaining: number; retryAfterMs: number } {
    cleanupExpired();

    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || now > entry.resetAt) {
        // Start a new window
        rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
    }

    if (entry.count >= limit) {
        const retryAfterMs = entry.resetAt - now;
        return { allowed: false, remaining: 0, retryAfterMs };
    }

    entry.count++;
    return { allowed: true, remaining: limit - entry.count, retryAfterMs: 0 };
}

/**
 * Returns a 429 Too Many Requests response.
 */
export function rateLimitResponse(request: Request, retryAfterMs: number, shopDomain?: string): Response {
    const headers = buildCorsHeaders(request, shopDomain);
    headers["Retry-After"] = String(Math.ceil(retryAfterMs / 1000));

    return new Response(
        JSON.stringify({ error: "Too many requests. Please slow down." }),
        {
            status: 429,
            headers: { ...headers, "Content-Type": "application/json" },
        }
    );
}

// ── Validators ───────────────────────────────────────────────────────────────

/**
 * Validate that a shop domain exists in the DB and is ACTIVE.
 * Returns the shop record or null.
 */
export async function validateShop(shopDomain: string) {
    if (!shopDomain || typeof shopDomain !== "string") return null;

    // Basic format check: must end with .myshopify.com or be a plausible domain
    const trimmed = shopDomain.trim().toLowerCase();
    if (trimmed.length === 0 || trimmed.length > 255) return null;

    try {
        const shop = await db.shop.findUnique({ where: { domain: trimmed } });
        if (!shop || shop.status !== "ACTIVE") return null;
        return shop;
    } catch {
        return null;
    }
}

/**
 * Validate that a sessionId has a valid CUID format.
 * CUIDs are 25 characters starting with 'c'.
 */
export function isValidSessionIdFormat(sessionId: string): boolean {
    if (!sessionId || typeof sessionId !== "string") return false;
    // CUIDs: start with 'c', 25 chars, alphanumeric
    return /^c[a-z0-9]{24}$/.test(sessionId);
}

/**
 * Validate that a ChatSession exists in the DB.
 */
export async function validateChatSession(sessionId: string) {
    if (!isValidSessionIdFormat(sessionId)) return null;
    try {
        return await db.chatSession.findUnique({ where: { id: sessionId } });
    } catch {
        return null;
    }
}
